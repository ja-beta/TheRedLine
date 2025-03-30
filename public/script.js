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
    const articlesRef = ref(db, 'news-03');
    onValue(articlesRef, (snapshot) => {
        const articles = snapshot.val();
        const articleList = document.getElementById('article-list');
        articleList.innerHTML = ""; 

        if (!articles) {
            articleList.innerHTML = "<p>No articles available.</p>";
            return;
        }

        const sortedArticles = Object.entries(articles)
            .map(([key, article]) => ({
                ...article,
                key
            }))
            .sort((a, b) => {
                // First sort by status - completed articles first, then pending
                if (a.processed === 'complete' && b.processed !== 'complete') return -1;
                if (a.processed !== 'complete' && b.processed === 'complete') return 1;
                // Then sort by timestamp (newest first)
                return (b.timestamp || 0) - (a.timestamp || 0);
            });  

        sortedArticles.forEach(article => {
            const articleElement = createArticleElement(article);
            articleList.appendChild(articleElement);
        });
    });
}

function createArticleElement(article) {
    const articleDiv = document.createElement('div');
    articleDiv.classList.add('article');
    
    articleDiv.setAttribute('data-id', article.key);

    if (article.processed) {
        articleDiv.classList.add(`status-${article.processed}`);
    }

    const title = document.createElement('h3');
    title.textContent = article.title || 'Untitled Article';

    const source = document.createElement('p');
    source.classList.add('source');
    source.textContent = article.source || 'Unknown Source';
    
    const timestamp = document.createElement('p');
    timestamp.classList.add('timestamp');
    if (article.timestamp) {
        const date = new Date(article.timestamp);
        timestamp.textContent = `Published: ${date.toLocaleString()}`;
    } else {
        timestamp.textContent = 'Publication date unknown';
    }

    const content = document.createElement('p');
    content.classList.add('content');
    content.textContent = article.content || article.summary || 'No content available';

    const status = document.createElement('p');
    status.classList.add('status');
    status.textContent = `Status: ${article.processed || 'Unknown'}`;

    const score = document.createElement('p');
    score.classList.add('score');
    
    if (article.processed === 'complete' && article.score !== undefined) {
        score.textContent = `Score: ${article.score.toFixed(6)}`;
    } else if (article.processed === 'pending') {
        score.textContent = 'Score: Pending analysis...';
    } else if (article.processed === 'error') {
        score.textContent = `Score: Error - ${article.error || 'Unknown error'}`;
    } else if (article.processed === 'duplicate') {
        score.textContent = 'Score: Duplicate article (skipped)';
    } else {
        score.textContent = 'Score: Unknown';
    }

    articleDiv.appendChild(title);
    articleDiv.appendChild(source);
    articleDiv.appendChild(timestamp);
    articleDiv.appendChild(content);
    articleDiv.appendChild(status);
    articleDiv.appendChild(score);

    return articleDiv;
}

window.exportArticlesToCSV = function() {
    const articlesRef = ref(db, 'news-03');
    
    onValue(articlesRef, (snapshot) => {
        const articles = snapshot.val();
        
        if (!articles) {
            console.log('No articles found in database');
            return;
        }

        let csvContent = 'Title,Source,Publication Date,Content,Status,Score\n';

        Object.values(articles).forEach(article => {
            const cleanTitle = (article.title || 'Untitled')
                .replace(/"/g, '""')
                .replace(/\n/g, ' ');
            const cleanSource = (article.source || 'Unknown')
                .replace(/"/g, '""')
                .replace(/\n/g, ' ');
            const pubDate = article.timestamp ? 
                new Date(article.timestamp).toISOString() : 'Unknown';
            const cleanContent = (article.content || article.summary || 'No content')
                .replace(/"/g, '""')
                .replace(/\n/g, ' ');
            const status = article.processed || 'Unknown';
            const score = (article.processed === 'complete' && article.score !== undefined) ? 
                article.score : 'N/A';
            
            csvContent += `"${cleanTitle}","${cleanSource}","${pubDate}","${cleanContent}","${status}","${score}"\n`;
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

function sendCustomScore() {
    const scoreInput = document.getElementById('customScore');
    const score = parseFloat(scoreInput.value);
    
    if (isNaN(score) || score < 0 || score > 1) {
        alert('Please enter a valid score between 0 and 1');
        return;
    }
    
    sendTestScore(score);
    scoreInput.value = ''; 
}

// Make the functions globally available
window.sendTestScore = sendTestScore;
window.resendCurrentScore = resendCurrentScore;
window.sendCustomScore = sendCustomScore;