// Vercel sends every /api/* request to this one Node function through the
// rewrite in vercel.json. Express receives the original URL and performs the
// route matching, exactly as it does during local development.
export { default } from "../server/index.js";
