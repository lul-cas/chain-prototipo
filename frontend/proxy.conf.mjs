// Dev-server proxy (ADR-0010 D7): the browser loads the app and calls the API from one origin,
// so the SameSite=Strict session cookie and the API's Origin check work unchanged.
// The target defaults to the compose service; on the host use
//   CHAIN_API_PROXY_TARGET=http://localhost:8080 npm start
const target = process.env['CHAIN_API_PROXY_TARGET'] ?? 'http://api:8080';

export default {
  '/api': {
    target,
    secure: false,
    // Keep the browser's Host and Origin headers: the API compares Origin with CHAIN_FRONTEND_ORIGIN.
    changeOrigin: false,
  },
};
