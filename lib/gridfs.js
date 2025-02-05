/**
 *
 * Plugin definition
 * @module multer-gridfs-storage/gridfs
 *
 */
const crypto = require('crypto');
const {EventEmitter} = require('events');
const mongodb = require('mongodb');

const isPromise = require('is-promise');
const isGenerator = require('is-generator');
const isGeneratorFn = isGenerator.fn;
const pump = require('pump');
const mongoUri = require('mongodb-uri');
const {getDatabase} = require('./utils');
const Cache = require('./cache');
const {ObjectID, MongoClient} = mongodb;

/**
 * Is GridFSBucket present or not
 * @const legacy
 **/
const legacy = !mongodb.GridFSBucket;

/**
 * Default file information
 * @const defaults
 **/
const defaults = {
	metadata: null,
	chunkSize: 261120,
	bucketName: 'fs',
	aliases: null
};

/**
 * Multer GridFS Storage Engine class definition.
 * @extends EventEmitter
 * @param {object} configuration
 * @param {string} [configuration.url] - The url pointing to a MongoDb database
 * @param {object} [configuration.options] - Options to use when connection with an url.
 * @param {object} [configuration.connectionOpts] - DEPRECATED: Use options instead.
 * @param {boolean | string} [configuration.cache] - Store this connection in the internal cache.
 * @param {Db | Promise} [configuration.db] - The MongoDb database instance to use or a promise that resolves with it
 * @param {Function} [configuration.file] - A function to control the file naming in the database
 * @fires GridFSStorage#connection
 * @fires GridFSStorage#connectionFailed
 * @fires GridFSStorage#file
 * @fires GridFSStorage#streamError
 * @fires GridFSStorage#dbError
 * @version 0.0.3
 */
class GridFSStorage extends EventEmitter {
	constructor(configuration) {
		super();

		if (!configuration || (!configuration.url && !configuration.db)) {
			throw new Error(
				'Error creating storage engine. At least one of url or db option must be provided.'
			);
		}

		this.setMaxListeners(0);

		this.db = null;
		this.client = null;
		this.connected = false;
		this.connecting = false;
		this.configuration = configuration;
		this.caching = false;
		this.cacheName = null;
		this.cacheIndex = null;
		this.error = null;

		this._file = this.configuration.file;
		this._legacy = legacy;

		if (this.configuration.url) {
			this.caching = Boolean(this.configuration.cache);
			this._options = this.configuration.options;
		}

		if (this.caching) {
			this.cacheName =
				typeof configuration.cache === 'string'
					? configuration.cache
					: 'default';
			this.cacheIndex = GridFSStorage.cache.initialize({
				url: configuration.url,
				cacheName: this.cacheName,
				init: this._options
			});
		}

		this._connect();
	}

	/**
	 * Determines if a new connection should be created, a explicit connection is provided or a cached instance is required.
	 * @private
	 */
	_connect() {
		const {db, client = null} = this.configuration;

		if (db && !isPromise(db) && !isPromise(client)) {
			this._setDb(db, client);
			return;
		}

		this._resolveConnection()
			/* eslint-disable-next-line promise/prefer-await-to-then */
			.then(({db, client}) => {
				this._setDb(db, client);
			})
			.catch((error) => this._fail(error));
	}

	/**
	 * Returns a promise that will resolve to the db and client from the cache or a new connection depending on the provided configuration
	 * @return {Promise<{client: *, db: *}>}
	 * @private
	 */
	async _resolveConnection() {
		this.connecting = true;
		const {db, client = null} = this.configuration;
		if (db) {
			const [_db, _client] = await Promise.all([db, client]);
			return {db: _db, client: _client};
		}

		if (!this.caching) {
			return this._createConnection();
		}

		const {cache} = GridFSStorage;
		if (!cache.isOpening(this.cacheIndex) && cache.isPending(this.cacheIndex)) {
			const cached = cache.get(this.cacheIndex);
			cached.opening = true;
			return this._createConnection();
		}

		return cache.waitFor(this.cacheIndex);
	}

	/**
	 * Handles creating a new connection from an url and storing it in the cache if necessary
	 * @return {Promise<{client: *, db: *}>}
	 * @private
	 */
	async _createConnection() {
		const {url} = this.configuration;
		const {_options: options} = this;

		const {cache} = GridFSStorage;
		try {
			let db;
			let client = null;
			const _db = await MongoClient.connect(url, options);
			let parsedUri;

			// Mongo 3 returns a client instead of a Db object
			if (_db instanceof MongoClient) {
				client = _db;
				parsedUri = mongoUri.parse(url);
				db = client.db(parsedUri.database);
			} else {
				db = _db;
			}

			if (this.caching) {
				cache.resolve(this.cacheIndex, db, client);
			}

			return {db, client};
		} catch (error) {
			if (this.cacheIndex) {
				cache.reject(this.cacheIndex, error);
			}

			throw error;
		}
	}

	/**
	 * Updates the connection status based on the internal db or client object
	 * @private
	 **/
	_updateConnectionStatus() {
		if (!this.db) {
			this.connected = false;
			this.connecting = false;
			return;
		}

		if (this.client) {
			this.connected = this.client.isConnected
				? this.client.isConnected()
				: true;
			return;
		}

		this.connected = this.db.topology.isConnected();
	}

	/**
	 * Sets the database connection and emit the connection event
	 * @param {object} db - Database instance or Mongoose instance to set
	 * @param {object} [client] - Optional Mongo client for MongoDb v3
	 * @private
	 **/
	_setDb(db, client) {
		this.connecting = false;
		// Check if the object is a mongoose instance, a mongoose Connection or a mongo Db object
		this.db = getDatabase(db);
		if (client) {
			this.client = client;
		}

		const errEvent = (err) => {
			// Needs verification. Sometimes the event fires without an error object
			// although the docs specify each of the events has a MongoError argument
			this._updateConnectionStatus();
			const error = err || new Error();
			this.emit('dbError', error);
		};

		// This are all the events that emit errors
		this.client
			.on('error', errEvent)
			.on('parseError', errEvent)
			.on('timeout', errEvent)
			.on('close', errEvent);
		this._updateConnectionStatus();

		// Emit on next tick so user code can set listeners in case the db object is already available
		process.nextTick(() => {
			this.emit('connection', {db: this.db, client: this.client});
		});
	}

	/**
	 * Removes the database reference and emit the connectionFailed event
	 * @param {object} err - The error received while trying to connect
	 * @private
	 **/
	_fail(err) {
		this.connecting = false;
		this.db = null;
		this.client = null;
		this.error = err;
		this._updateConnectionStatus();
		// Fail event is only emitted after either a then promise handler or an I/O phase so is guaranteed to be asynchronous
		this.emit('connectionFailed', err);
	}

	/**
	 * Create a writable stream with backwards compatibility with GridStore
	 * @param {object} options - The stream options
	 * @return {GridStoreStream | GridFSBucketWriteStream}
	 */
	createStream(options) {
		let gfs;
		let settings;
		const {GridStore} = mongodb;
		const {GridFSBucket} = mongodb;

		if (this._legacy) {
			// `disableMD5` is not supported in GridStore
			settings = {
				/* eslint-disable-next-line camelcase */
				chunk_size: options.chunkSize,
				metadata: options.metadata,
				/* eslint-disable-next-line camelcase */
				content_type: options.contentType,
				root: options.bucketName,
				aliases: options.aliases
			};
			gfs = new GridStore(this.db, options.id, options.filename, 'w', settings);
			return gfs.stream();
		}

		settings = {
			id: options.id,
			chunkSizeBytes: options.chunkSize,
			contentType: options.contentType,
			metadata: options.metadata,
			aliases: options.aliases,
			disableMD5: options.disableMD5
		};
		gfs = new GridFSBucket(this.db, {bucketName: options.bucketName});
		return gfs.openUploadStream(options.filename, settings);
	}

	/**
	 * Storage interface method to handle incoming files
	 * @param {Request} request - The request that trigger the upload
	 * @param {File} file - The uploaded file stream
	 * @param {function} cb - A standard node callback to signal the end of the upload or an error
	 **/
	_handleFile(request, file, cb) {
		if (this.connecting) {
			this.ready()
				/* eslint-disable-next-line promise/prefer-await-to-then */
				.then(() => this.fromFile(request, file))
				/* eslint-disable-next-line promise/prefer-await-to-then */
				.then((file) => cb(null, file))
				.catch(cb);
			return;
		}

		this._updateConnectionStatus();
		if (this.connected) {
			this.fromFile(request, file)
				/* eslint-disable-next-line promise/prefer-await-to-then */
				.then((file) => cb(null, file))
				.catch(cb);
			return;
		}

		cb(new Error('The database connection must be open to store files'));
	}

	/**
	 * Storage interface method to delete files in case an error turns the request invalid
	 * @param {Request} request - The request that trigger the upload
	 * @param {File} file - The uploaded file stream
	 * @param {function} cb - A standard node callback to signal the end of the upload or an error
	 **/
	_removeFile(request, file, cb) {
		let bucket;
		let options;
		const {GridStore} = mongodb;
		const {GridFSBucket} = mongodb;

		if (this._legacy) {
			options = {root: file.bucketName};
			GridStore.unlink(this.db, file.id, options, cb);
		} else {
			options = {bucketName: file.bucketName};
			bucket = new GridFSBucket(this.db, options);
			bucket.delete(file.id, cb);
		}
	}

	/**
	 * Pipes the file stream to the MongoDb database. The file requires a property named `file` which is a readable stream
	 * @param {Request} request - The http request where the file was uploaded
	 * @param {File} file - The file stream to pipe
	 * @return  {Promise} Resolves with the uploaded file
	 */
	fromFile(request, file) {
		return this.fromStream(file.stream, request, file);
	}

	/**
	 * Pipes the file stream to the MongoDb database. The request and file parameters are optional and used for file generation only
	 * @param {ReadStream} readStream - The http request where the file was uploaded
	 * @param {Request} [request] - The http request where the file was uploaded
	 * @param {File} [file] - The file stream to pipe
	 * @return {Promise} Resolves with the uploaded file
	 */
	async fromStream(readStream, request, file) {
		if (this.connecting) {
			await this.ready();
		}

		const fileSettings = await this._generate(request, file);
		let settings;
		const setType = typeof fileSettings;
		const allowedTypes = new Set(['undefined', 'number', 'string', 'object']);
		if (!allowedTypes.has(setType)) {
			throw new Error('Invalid type for file settings, got ' + setType);
		}

		if (fileSettings === null || fileSettings === undefined) {
			settings = {};
		} else if (setType === 'string' || setType === 'number') {
			settings = {
				filename: fileSettings.toString()
			};
		} else {
			settings = fileSettings;
		}

		const contentType = file ? file.mimetype : undefined;
		const streamOptions = await GridFSStorage._mergeProps(
			{contentType},
			settings
		);
		let store;
		return new Promise((resolve, reject) => {
			const emitError = (streamError) => {
				this.emit('streamError', streamError, streamOptions);
				reject(streamError);
			};

			const emitFile = (f) => {
				const storedFile = {
					id: f._id,
					filename: f.filename,
					metadata: f.metadata || null,
					bucketName: streamOptions.bucketName,
					chunkSize: f.chunkSize,
					size: f.length,
					md5: f.md5,
					uploadDate: f.uploadDate,
					contentType: f.contentType
				};
				this.emit('file', storedFile);
				resolve(storedFile);
			};

			const writeStream = this.createStream(streamOptions);

			// Multer already handles the error event on the readable stream(Busboy).
			// Invoking the callback with an error will cause file removal and aborting routines to be called twice
			writeStream.on('error', emitError);

			if (this._legacy) {
				store = writeStream.gs;
				// In older mongo versions there is a race condition when the store is opening and the stream is
				// switched into flowing mode that causes the index not to be properly initialized so is better to open the store first
				store.open((error) => {
					if (error) {
						return emitError(error);
					}

					writeStream.on('end', () => {
						store.close((err, f) => {
							if (err) {
								return emitError(err);
							}

							emitFile(f);
						});
					});
					pump(readStream, writeStream);
				});
			} else {
				writeStream.on('finish', emitFile);
				pump(readStream, writeStream);
			}
		});
	}

	/**
	 * Tests for generator functions or plain functions and delegates to the appropriate method
	 * @param {Request} request - The request that trigger the upload as received in _handleFile
	 * @param {File} file - The uploaded file stream as received in _handleFile
	 * @return {Promise<any | {}>} A promise with the value generated by the file function
	 **/
	async _generate(request, file) {
		let result;
		let generator;
		let isGen = false;

		if (!this._file) {
			return {};
		}

		if (isGeneratorFn(this._file)) {
			isGen = true;
			generator = this._file(request, file);
			this._file = generator;
			result = generator.next();
		} else if (isGenerator(this._file)) {
			isGen = true;
			generator = this._file;
			result = generator.next([request, file]);
		} else {
			result = this._file(request, file);
		}

		return GridFSStorage._handleResult(result, isGen);
	}

	/**
	 * Waits for the MongoDb connection associated to the storage to succeed or fail
	 * @return {Promise<{db: *, client: *}>} Resolves or reject depending on the result of the MongoDb connection
	 */
	async ready() {
		if (this.error) {
			throw this.error;
		}

		if (this.connected) {
			return {db: this.db, client: this.client};
		}

		return new Promise((resolve, reject) => {
			const done = (result) => {
				this.removeListener('connectionFailed', fail);
				resolve(result);
			};

			const fail = (err) => {
				this.removeListener('connection', done);
				reject(err);
			};

			this.once('connection', done);
			this.once('connectionFailed', fail);
		});
	}

	/**
	 * Handles generator function and promise results
	 * @param {object} result - Can be a promise or a generator yielded value
	 * @param {boolean} isGen - True if is a yielded value
	 * @return {Promise} The generator value or a plain value wrapped in a Promise
	 * @private
	 **/
	static async _handleResult(result, isGen) {
		let value = result;

		if (isGen) {
			if (result.done) {
				throw new Error('Generator ended unexpectedly');
			}

			value = result.value;
		}

		return value;
	}

	/**
	 * Merge the properties received in the file function with default values
	 * @param extra {object} Extra properties like contentType
	 * @param fileSettings {object} Properties received in the file function
	 * @return {Promise} An object with the merged properties wrapped in a promise
	 * @private
	 */
	static async _mergeProps(extra, fileSettings) {
		// If the filename is not provided generate one
		const previous = await (fileSettings.filename
			? {}
			: GridFSStorage.generateBytes());
		// If no id is provided generate one
		// If an error occurs the emitted file information will contain the id
		const hasId = fileSettings.id;
		if (!hasId) {
			previous.id = new ObjectID();
		}

		return {...previous, ...defaults, ...extra, ...fileSettings};
	}

	/**
	 * Generates 16 bytes long strings in hexadecimal format
	 * @return {Promise<{filename: string}>} A promise containing object with the filename property with the generated string
	 */
	static generateBytes() {
		return new Promise((resolve, reject) => {
			crypto.randomBytes(16, (err, buffer) => {
				if (err) {
					return reject(err);
				}

				resolve({filename: buffer.toString('hex')});
			});
		});
	}
}

/**
 * Event emitted when the MongoDb connection is ready to use
 * @event module:multer-gridfs-storage/gridfs~GridFSStorage#connection
 * @param {{db: Db, client: MongoClient}} result - An object containing the mongodb database and client
 * @version 0.0.3
 */

/**
 * Event emitted when the MongoDb connection fails to open
 * @event module:multer-gridfs-storage/gridfs~GridFSStorage#connectionFailed
 * @param {Error} err - The error received when attempting to connect
 * @version 2.0.0
 */

/**
 * Event emitted when a new file is uploaded
 * @event module:multer-gridfs-storage/gridfs~GridFSStorage#file
 * @param {File} file - The uploaded file
 * @version 0.0.3
 */

/**
 * Event emitted when an error occurs streaming to MongoDb
 * @event module:multer-gridfs-storage/gridfs~GridFSStorage#streamError
 * @param {Error} error - The error thrown by the stream
 * @param {Object} conf - The failed file configuration
 * @version 1.3
 */

/**
 * Event emitted when the internal database connection emits an error
 * @event module:multer-gridfs-storage/gridfs~GridFSStorage#dbError
 * @param {Error} error - The error thrown by the database connection
 * @version 1.2.2
 **/

/**
 * The cache used by the module
 * @type {Cache}
 */
GridFSStorage.cache = new Cache();

module.exports = new Proxy(GridFSStorage, {
	apply(target, thisArg, argumentsList) {
		/* eslint-disable-next-line new-cap */
		return new target(...argumentsList);
	}
});
