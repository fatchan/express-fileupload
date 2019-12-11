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

  const cleanups = [];
  req.on('aborted', () => {
    cleanups.forEach(cleanup => {
      cleanup();
	})
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
    const {dataHandler, getFilePath, getFileSize, getHash, complete, cleanup} = options.useTempFiles
      ? tempFileHandler(options, field, filename) // Upload into temporary file.
      : memHandler(options, field, filename);     // Upload into RAM.
    // Define upload timer settings and clear/set functions.
    let uploadTimer = null;
    const timeout = options.uploadTimeout;
    const clearUploadTimer = () => clearTimeout(uploadTimer);
    const setUploadTimer = () => {
      clearUploadTimer();
      uploadTimer = setTimeout(() => {
        debugLog(options, `Upload timeout ${field}->${filename}, bytes:${getFileSize()}`);
        cleanup();
      }, timeout);
    };

	cleanups.push(cleanup);

    file.on('limit', () => {
      debugLog(options, `Size limit reached for ${field}->${filename}, bytes:${getFileSize()}`);
      // Run a user defined limit handler if it has been set.
      if (isFunc(options.limitHandler)) return options.limitHandler(req, res, next);
      // Close connection with 413 code and do cleanup if abortOnLimit set(default: false).
      if (options.abortOnLimit) {
        debugLog(options, `Aborting upload because of size limit ${field}->${filename}.`);
        closeConnection(413, options.responseOnLimit);
        cleanup();
      }
    });

    file.on('data', dataHandler);

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
    });

    file.on('error', (err) => {
      debugLog(options, `Error ${field}->${filename}, bytes:${getFileSize()}, error:${err}`);
      cleanup();
      next();
    });

    // Debug logging for a new file upload.
    debugLog(options, `New upload started ${field}->${filename}, bytes:${getFileSize()}`);
    // Set new upload timeout for a new file.
    setUploadTimer();
  });

  busboy.on('filesLimit', () => {
    if (isFunc(options.numFilesLimitHandler)){
      return options.numFilesLimitHandler(req, res, next);
    }
  });

  busboy.on('finish', () => {
    if (options.parseNested) {
      req.body = processNested(req.body);
      req.files = processNested(req.files);
    }
    next();
  });

  busboy.on('error', next);

  req.pipe(busboy);
};
