export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  const code = err.code || 'INTERNAL';
  if (status === 500) {
    console.error(err);
  }
  res.status(status).json({
    error: {
      code,
      message: status === 500 ? 'Internal server error' : err.message,
    },
  });
}
