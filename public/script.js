import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase, ref, onValue, update, set, onChildAdded, onChildChanged } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { firebaseConfig } from './config.js';

let db;

// Initialize Firebase and Realtime Database
document.addEventListener("DOMContentLoaded", () => {
    initFirebaseDB();
    subscribeToNewArticles();  
    subscribeToScoreUpdates();  
    displayMainScore();
    displayArticles();
});

function displayMainScore() {
    const mainScoreRef = ref(db, 'mainScore');

    onValue(mainScoreRef, (snapshot) => {
        const data = snapshot.val();
        const mainScore = data ? data.score : 0;
        updateMainScoreUI(mainScore);
    });
}

function updateMainScoreUI(score) {
    const mainScoreMeter = document.getElementById('main-score-meter');
    const mainScoreLabel = document.getElementById('main-score-label');

    mainScoreMeter.value = score;
    mainScoreLabel.textContent = score.toFixed(6);
}

function displayArticles() {
    const newsRef = ref(db, 'news');

    onValue(newsRef, (snapshot) => {
        const articles = snapshot.val();
        console.log("Fetched articles from Firebase:", articles); 

        if (articles && Object.keys(articles).length > 0) {
            updateArticleListUI(articles);
        } else {
            console.log("No articles available in Firebase."); 
            updateArticleListUI(null);  
        }
    });
}



function updateArticleListUI(articles) {
    const articleList = document.getElementById('article-list');
    articleList.innerHTML = '';  

    if (!articles) {
        console.log("No articles found.");  
        return;
    }

    Object.keys(articles).forEach((key) => {
        const article = articles[key];
        const listItem = document.createElement('li');

        const title = document.createElement('strong');
        title.textContent = article.title;

        const score = document.createElement('span');
        score.textContent = ` - Score: ${article.score !== null ? article.score.toFixed(6) : 'Calculating...'}`;

        listItem.appendChild(title);
        listItem.appendChild(score);
        articleList.appendChild(listItem);
    });
}


// Initialize Firebase Realtime Database
function initFirebaseDB() {
    const app = initializeApp(firebaseConfig);
    db = getDatabase();
}

// Subscribe to new articles being added to the database
function subscribeToNewArticles() {
    const newsRef = ref(db, 'news');

    // Listen for new articles being added
    onChildAdded(newsRef, (snapshot) => {
        const article = snapshot.val();
        if (article && !article.score) {
            const prompt = `Please perform sentiment analysis on the following text: ${article.title}. Provide a score between 0 and 1, 0 being negative and 1 being positive. Your answer should a floating point number of up to 6 decimal places, and should contain no other characters or spaces.`;
            askValue(prompt, snapshot.key);
        }
    });
}

// Perform sentiment analysis and update the score in the database
async function askValue(prompt, key) {
    const data = {
        modelURL: "https://api.replicate.com/v1/models/meta/meta-llama-3-70b-instruct/predictions",
        input: {
            prompt: prompt,
        },
    };

    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: 'application/json',
        },
        body: JSON.stringify(data),
    };

    try {
        const response = await fetch(apiUrl, options);  // Assuming apiUrl is defined elsewhere
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const result = await response.json();
        const score = result.output[0]; 

        // Update the score in Firebase Realtime Database
        updateScoreInFirebase(key, parseFloat(score));
    } catch (error) {
        console.error("Error fetching sentiment score:", error);
    }
}

// Update the score in Firebase for the given article
function updateScoreInFirebase(key, score) {
    const newsRef = ref(db, `news/${key}`);
    update(newsRef, { score: score })
        .then(() => {
            console.log("Score updated successfully");
        })
        .catch((error) => {
            console.error("Error updating score:", error);
        });
}

// Subscribe to article score updates and update the main score
function subscribeToScoreUpdates() {
    const newsRef = ref(db, 'news');

    onChildChanged(newsRef, (snapshot) => {
        const updatedArticle = snapshot.val();
        if (updatedArticle && typeof updatedArticle.score === "number") {
            calculateAndUpdateMainScore();  // Recalculate main score when an article score is updated
        }
    });
}

// Calculate the main score by averaging all article scores
function calculateAndUpdateMainScore() {
    const newsRef = ref(db, 'news');

    onValue(newsRef, (snapshot) => {
        const articles = snapshot.val();
        const keys = Object.keys(articles || {});
        const totalScores = keys.reduce((sum, key) => sum + (articles[key].score || 0), 0);
        const averageScore = totalScores / keys.length;

        console.log("Calculated average score:", averageScore);
        updateMainScore(averageScore);
    });
}

// Update the main score in the database
function updateMainScore(averageScore) {
    const mainScoreRef = ref(db, 'mainScore');
    set(mainScoreRef, { score: averageScore })
        .then(() => {
            console.log("Main score updated successfully");
        })
        .catch((error) => {
            console.error("Error updating main score:", error);
        });
}
