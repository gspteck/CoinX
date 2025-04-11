const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {	
  res.send(path.join(__dirname, "https://gspteck.com"));	
});

app.get("/coindrop", (req, res) => {
  res.sendFile(path.join(__dirname, "public/views/coindrop.html"));	
});

app.listen(PORT, () => {
  console.log("Server started at http://localhost:" + PORT);
});
