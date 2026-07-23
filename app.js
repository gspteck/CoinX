const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 8080;

// Local development static server only.
// The real /coindrop/api/rankgoat-publish webhook and dynamic coindrop pages
// run as Firebase Cloud Functions (see functions/index.js + firebase.json rewrites).

// Security and SEO-friendly headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Robots-Tag", "index, follow");
  next();
});

// Serve static assets
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "7d",
    etag: true,
    lastModified: true,
  })
);

// Explicit routes for the main site
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/coindrop", (req, res) => {
  res.sendFile(path.join(__dirname, "public/views/coindrop.html"));
});

// Sitemap and robots (static base versions for local dev)
// In production, /robots.txt and /sitemap.xml are served by global Cloud Functions
// that dynamically include all published /coindrop pages.
app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml");
  res.sendFile(path.join(__dirname, "public/sitemap.xml"));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "public/robots.txt"));
});

// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public/404.html"));
});

app.listen(PORT, () => {
  console.log("Server started at http://localhost:" + PORT);
  console.log("Note: /coindrop/api/rankgoat-publish webhook runs in Firebase Cloud Functions in production.");
});
