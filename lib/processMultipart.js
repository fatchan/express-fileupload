const Busboy = require('busboy');
const fileFactory = require('./fileFactory');
const memHandler = require('./memHandler');
const tempFileHandler = require('./tempFileHandler');
const processNested = require('./processNested');
const {
  isFunc,
  debugLog,
  buildFields,
  buildOptions,
  parseFileName
} = require('./utilities');

const waitFlushProperty = Symbol('wait flush property symbol');

/**
 * Processes multipart request
 * Builds a req.body object for fields
 * Builds a req.files object for files
 * @param  {Object}   options expressFileupload and Busboy options
 * @param  {Object}   req     Express request object
 * @param  {Object}   res     Express response object
 * @param  {Function} next    Express next method
 * @return {void}
 */
module.exports = (options, req, res, next) => {
  req.files = null;
  let totalSize = 0;
  debugLog(options, `Request with content-length header ${req.headers['content-length']}`);
  if (req.headers['content-length'] > options.limits.totalSize) {
	return options.limitHandler(req, res, next);
  }
  const cleanups = [];
  const cleanAll = () => {
    cleanups.forEach(cleanup => {
      cleanup();
	});
  }
  req.on('aborted', () => {
	cleanAll();
  });

  // Build busboy options and init busboy instance.
  const busboyOptions = buildOptions(options, { headers: req.headers });
  const busboy = new Busboy(busboyOptions);

  // Close connection with specified reason and http code, default: 400 Bad Request.
  const closeConnection = (code, reason) => {
    req.unpipe(busboy);
    res.writeHead(code || 400, { Connection: 'close' });
    res.end(reason || 'Bad Request');
  };

  // Build multipart req.body fields
  busboy.on('field', (field, val) => req.body = buildFields(req.body, field, val));

  // Build req.files fields
  busboy.on('file', (field, file, name, encoding, mime) => {
    // Parse file name(cutting huge names, decoding, etc..).
    const filename = parseFileName(options, name);
    // Define methods and handlers for upload process.
    const {
      dataHandler,
      getFilePath,
      getFileSize,
      getHash,
      complete,
      cleanup,
      getWritePromise
    } = options.useTempFiles
      ? tempFileHandler(options, field, filename) // Upload into temporary file.
      : memHandler(options, field, filename);     // Upload into RAM.

	cleanups.push(cleanup);

    file.on('limit', () => {
      debugLog(options, `Size limit reached for ${field}->${filename}, bytes:${getFileSize()}`);
      // Run a user defined limit handler if it has been set.
      if (isFunc(options.limitHandler)) {
            req.unpipe(busboy);
			cleanAll();
            return options.limitHandler(req, res, next);
        }
      // Close connection with 413 code and do cleanup if abortOnLimit set(default: false).
      if (options.abortOnLimit) {
        debugLog(options, `Aborting upload because of size limit ${field}->${filename}.`);
        closeConnection(413, options.responseOnLimit);
        cleanAll();
      }
    });

    file.on('data', (data) => {
		totalSize+=data.length;
		if (totalSize > options.limits.totalSize) {
			debugLog(options, `Aborting upload because of size limit.`);
            req.unpipe(busboy);
			cleanAll();
            return options.limitHandler(req, res, next);
		}
		dataHandler(data);
	});

    file.on('end', () => {
      // Debug logging for a new file upload.
      debugLog(options, `Upload finished ${field}->${filename}, bytes:${getFileSize()}`);
      // Add file instance to the req.files
      req.files = buildFields(req.files, field, fileFactory({
        buffer: complete(),
        name: filename,
        tempFilePath: getFilePath(),
        size: getFileSize(),
        hash: getHash(),
        encoding,
        truncated: file.truncated,
        mimetype: mime
      }, options));

      if (!req[waitFlushProperty]) {
        req[waitFlushProperty] = [];
      }
      req[waitFlushProperty].push(getWritePromise());
    });

    file.on('error', (err) => {
      debugLog(options, `Error ${field}->${filename}, bytes:${getFileSize()}, error:${err}`);
      cleanAll();
      next();
    });

    // Debug logging for a new file upload.
    debugLog(options, `New upload started ${field}->${filename}, bytes:${getFileSize()}`);
  });

  busboy.on('filesLimit', () => {
    if (isFunc(options.numFilesLimitHandler)){
      return options.numFilesLimitHandler(req, res, next);
    }
  });

  busboy.on('finish', () => {
    const handler = (err) => {
      if (options.parseNested) {
        req.body = processNested(req.body);
        req.files = processNested(req.files);
      }
      next(err);
    };

    if (req[waitFlushProperty]) {
      Promise.all(req[waitFlushProperty])
        .then(() => {
          delete req[waitFlushProperty];
          handler();
        })
        .catch(err => {
          delete req[waitFlushProperty];
          debugLog(options, `Error wait flush error:${err}`);
          handler(err);
        });
    } else {
      handler();
    }
  });

  busboy.on('error', next);

  req.pipe(busboy);
};
