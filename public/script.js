import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase, ref, onValue, update, set, onChildAdded, onChildChanged } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { firebaseConfig, apiUrl } from './config.js';

let db;

document.addEventListener("DOMContentLoaded", () => {
    initFirebaseDB(); 
    displayMainScore();  
    displayArticles();  
});

function initFirebaseDB() {
    const app = initializeApp(firebaseConfig);
    db = getDatabase();
}

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
    const articlesRef = ref(db, 'news');
    onValue(articlesRef, (snapshot) => {
        const articles = snapshot.val();
        const articleList = document.getElementById('article-list');
        articleList.innerHTML = ""; 

        if (!articles) {
            articleList.innerHTML = "<p>No articles available.</p>";
            return;
        }

        Object.keys(articles).forEach(key => {
            const article = articles[key];
            const articleElement = createArticleElement(article);
            articleList.appendChild(articleElement);
        });
    });
}

function createArticleElement(article) {
    const articleDiv = document.createElement('div');
    articleDiv.classList.add('article');

    const title = document.createElement('h3');
    title.textContent = article.title;

    const summary = document.createElement('p');
    summary.textContent = article.summary;

    const score = document.createElement('p');
    score.textContent = `Score: ${article.score !== "pending" ? article.score.toFixed(6) : "Pending"}`;

    articleDiv.appendChild(title);
    articleDiv.appendChild(summary);
    articleDiv.appendChild(score);

    return articleDiv;
}


window.exportArticlesToCSV = function() {
    const articlesRef = ref(db, 'news');
    
    onValue(articlesRef, (snapshot) => {
        const articles = snapshot.val();
        
        if (!articles) {
            console.log('No articles found in database');
            return;
        }

        let csvContent = 'Summary,Score\n'; // Header row

        Object.values(articles).forEach(article => {
            const cleanSummary = article.summary
                .replace(/"/g, '""')
                .replace(/\n/g, ' ');
            csvContent += `"${cleanSummary}",\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', `articles_${timestamp}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
};
