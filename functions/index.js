const functions = require('firebase-functions/v2');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();

exports.fetchNews = functions.https.onRequest(async (req, res) => {
    const API_KEY = process.env.NEWSCATCHER_API_KEY;
  
    if (!API_KEY) {
      console.error("NewsCatcher API key is missing.");
      res.status(500).send("Internal Server Error: API key is missing.");
      return;
    }
  
    const url = 'https://api.newscatcherapi.com/v2/latest_headlines?lang=en&when=7d&page_size=100';
  
    const options = {
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
      },
    };
  
    try {
      console.log("Fetching latest headlines from NewsCatcher API...");
      const response = await fetch(url, options);
      if (!response.ok) {
        console.error(`NewsCatcher API request failed. Status: ${response.status}`);
        throw new Error(`API request failed with status ${response.status}`);
      }
  
      const result = await response.json();
      console.log("NewsCatcher API response:", result);
  
      const filteredArticles = result.articles.filter(article =>
        article.summary.toLowerCase().includes('Israel') || article.summary.toLowerCase().includes('Israeli')
      );
      console.log("Filtered articles:", filteredArticles);
  
      if (filteredArticles.length === 0) {
        console.warn("No articles found that match the criteria.");
        res.status(200).send({ message: "No articles matching the criteria." });
        return;
      }
  
      const ref = admin.database().ref('news');
  
      const writePromises = filteredArticles.map(async (article) => {
        const existingArticleSnapshot = await ref.orderByChild('title').equalTo(article.title).once('value');
        if (existingArticleSnapshot.exists()) {
          console.log(`Article "${article.title}" already exists. Skipping...`);
          return;
        }
  
        const articleRef = await ref.push({
          title: article.title,
          summary: article.summary,
          link: article.link,
          timestamp: Date.now(),
          score: "pending",
        });

        const prompt = `Please provide a sentiment analysis score for the following text: "${article.summary}". When calculating the score, consider the greater good of people living in the geographic region known as Israel / Palestine and the impact that's described in the text could have over their future. The score must be a floating point number between 0 and 1 (0 is negative sentiment and 1 is positive sentiment) with up to 6 decimal places. The answer should only contain the number, no additional characters, spaces, or line breaks.`;
        await askValue(prompt, articleRef.key);
      });
  
      await Promise.all(writePromises);
      console.log("All new articles written to Firebase successfully.");
      res.status(200).send({ message: "Articles stored successfully." });
  
    } catch (error) {
      console.error("Error in fetchNews function:", error.message);
      res.status(500).send("Internal Server Error");
    }
});

async function askValue(prompt, key) {
    console.log("Sending sentiment analysis request for article:", key);

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
        // const response = await fetch(process.env.REPLICATE_API_URL, options);
        const response = await fetch("https://replicate-api-proxy.glitch.me/create_n_get/", options);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log("API Response:", result);
        let score;
        if (Array.isArray(result.output)) {
            const rawScore = result.output.join('').replace(/[^0-9.]/g, '');
            score = parseFloat(rawScore);
        } else {
            score = parseFloat(result.output);
        }

        if (!isNaN(score)) {
            console.log(`Valid score received for article ${key}:`, score);
            await updateScoreInFirebase(key, score);
        } else {
            console.error(`Invalid score received for article ${key}:`, result.output);
        }
    } catch (error) {
        console.error("Error fetching sentiment score:", error);
    }
}

async function updateScoreInFirebase(key, score) {
    const newsRef = admin.database().ref(`news/${key}`);
    await newsRef.update({ score: score });
    console.log(`Score successfully updated in Firebase for article ${key}`);
    calculateAndDisplayWeightedAverage();
}

async function calculateAndDisplayWeightedAverage() {
    const newsRef = admin.database().ref('news');
    const snapshot = await newsRef.once('value');
    const articles = snapshot.val();
    const keys = Object.keys(articles || {});
    const currentTime = Date.now();
    let totalWeightedScore = 0;
    let totalWeight = 0;

    const decayConstant = 14 * 24 * 60 * 60 * 1000;  // 2 weeks (its days * hrs * mins * secs * ms)

    keys.forEach((key) => {
        const article = articles[key];
        const articleTime = article.timestamp;
        const timeDifference = currentTime - articleTime;
        const weight = Math.exp(-timeDifference / decayConstant);

        if (!isNaN(article.score)) {
            totalWeightedScore += article.score * weight;
            totalWeight += weight;
        }
    });

    const weightedAverage = totalWeight === 0 ? 0 : totalWeightedScore / totalWeight;
    console.log(`Calculated weighted average score: ${weightedAverage}`);
    await updateMainScore(weightedAverage);
}

async function updateMainScore(weightedAverage) {
    const mainScoreRef = admin.database().ref('mainScore');
    await mainScoreRef.set({ score: weightedAverage });
    console.log("Main score updated successfully.");
}
