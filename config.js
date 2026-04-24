// frontend/config.js
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

window.API_BASE_URL = isLocal
  ? '' // same origin — backend serves the frontend on port 5500
  : 'https://smcs-backend-2.onrender.com/api';
