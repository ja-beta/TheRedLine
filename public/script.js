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

//MQTT TESTING ___________________________________________________________________
const MQTT_TOPIC = 'mainScore';

const client = mqtt.connect('wss://theredline.cloud.shiftr.io', {
    username: "theredline",
    password: "thisisit"
});

client.on('connect', () => {
    document.getElementById('status').textContent = 'Connection status: Connected';
    client.subscribe('mainScore', { qos: 1 });
});

client.on('message', (topic, message) => {
    document.getElementById('lastMessage').textContent = `Last message: ${message.toString()}`;
});

client.on('error', (err) => {
    document.getElementById('status').textContent = `Connection status: Error - ${err}`;
});

function sendTestScore(score) {
    const message = JSON.stringify({ score: score });
    client.publish('mainScore', message, { qos: 1 }, (err) => {
        if (err) {
            console.error('Failed to publish message:', err);
        } else {
            console.log(`Published score to MQTT topic "${MQTT_TOPIC}":`, message);
        }
    });
}

async function resendCurrentScore() {
    try {
        const mainScoreRef = ref(db, 'mainScore');
        onValue(mainScoreRef, (snapshot) => {
            const data = snapshot.val();
            if (data && data.score !== undefined) {
                sendTestScore(data.score);
            } else {
                console.error('Current score not found in database');
            }
        });
    } catch (error) {
        console.error('Error fetching current score:', error);
    }
}


// Make the functions globally available
window.sendTestScore = sendTestScore;
window.resendCurrentScore = resendCurrentScore;