const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Import Gemini client with ESM workaround since your file uses CommonJS
// We can use dynamic import for this in CommonJS
let GoogleGenerativeAI;
(async () => {
    const mod = await import("@google/generative-ai");
    GoogleGenerativeAI = mod.GoogleGenerativeAI;
})();

const app = express();

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect("mongodb://127.0.0.1:27017/craftquizai")
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.log(err));

// User Schema
const UserSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    password: String
});
const User = mongoose.model("User", UserSchema);

// SignUp
app.post("/signup", async (req, res) => {
    try {
        let { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password are required" });
        }
        email = email.trim().toLowerCase();
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "User already exists" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ email, password: hashedPassword });
        await newUser.save();
        res.json({ success: true, message: "Signup successful" });
    } catch (err) {
        console.error("Signup Error:", err);
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: "User already exists" });
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// Login
app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    console.log("Login Data Received");
    const user = await User.findOne({ email });
    if (!user) return res.json({ success: false, message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.json({ success: false, message: "Invalid password" });

    res.json({ success: true, message: "Login successful" });
});

// Setup multer storage for PDF upload
const upload = multer({ dest: "uploads/" });

// Wait for Gemini client to load before using it
async function getGeminiClient() {
    if (!GoogleGenerativeAI) {
        const mod = await import("@google/generative-ai");
        GoogleGenerativeAI = mod.GoogleGenerativeAI;
    }
    return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}
let generatedQuiz = null;
// PDF upload and quiz generation route

function cleanJsonString(text) {
    return text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
}

app.post("/uploadpdf", upload.single("pdf"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        // Read the PDF file buffer
        const pdfBuffer = fs.readFileSync(path.resolve(req.file.path));
        const pdfData = await pdfParse(pdfBuffer);
        const pdfText = pdfData.text;

        // Build prompt for Gemini AI
        const prompt = `Generate exactly 10 multiple-choice questions from the following text.

Output ONLY a JSON array containing 10 objects. Each object must have the following keys:

- "question": a string with the question text.
- "options": an array of 4 strings representing answer choices.
- "correct": an integer from 0 to 3 indicating the index of the correct option.

Example output:

[
  {
    "question": "What is ...?",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correct": 2
  },
  ...
]

The output MUST be valid JSON parsable by standard JSON parsers.
Do NOT include any explanations, notes, or text outside the JSON array.
Do NOT use trailing commas.
Here is the text to use:

"""${pdfText}"""

    `;

        const genAI = await getGeminiClient();
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const response = await model.generateContent(prompt);
        // console.log(response)
        const rawResponse = await response.response.text();
        const cleanedResponse = cleanJsonString(rawResponse);

        let quiz;
        try {
            quiz = JSON.parse(cleanedResponse);
        } catch (e) {
            console.error("JSON parse error:");
            return res.status(500).json({ error: "Failed to parse quiz JSON from AI response" });
        }
        res.json({ quiz });
        generatedQuiz = quiz;
        console.log("GEN-QUIZ", generatedQuiz)

    } catch (error) {
        console.error("Error in /uploadpdf:", error);
        res.status(500).json({ error: "Failed to generate quiz" });
    }
});
app.get("/quiz", async (req, res) => {
    if (generatedQuiz) {
        console.log("GEN-QUIZ", generatedQuiz)
        res.json({ quiz: generatedQuiz });
    }

});


app.listen(5000);
