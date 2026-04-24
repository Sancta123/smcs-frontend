// frontend/config.js
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

window.API_BASE_URL = isLocal
  ? 'http://localhost:5500'
  : 'https://smcs-backend-1.onrender.com';
