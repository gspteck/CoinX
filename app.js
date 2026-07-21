const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 8080;

// Security and SEO-friendly headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Allow search engines to index public pages
  res.setHeader("X-Robots-Tag", "index, follow");
  next();
});

// Serve static assets with long-term caching for performance/SEO
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "7d",
    etag: true,
    lastModified: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Explicit routes (also covered by static, but explicit is clearer)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/coindrop", (req, res) => {
  res.sendFile(path.join(__dirname, "public/views/coindrop.html"));
});

// Sitemap and robots explicitly (good for crawlers)
app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml");
  res.sendFile(path.join(__dirname, "public/sitemap.xml"));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "public/robots.txt"));
});

// Custom 404 handler - serve branded 404 page
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public/404.html"));
});

app.listen(PORT, () => {
  console.log("Server started at http://localhost:" + PORT);
});
