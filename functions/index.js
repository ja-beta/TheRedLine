const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();

exports.fetchNews = functions.https.onRequest(async (req, res) => {
  const API_KEY = functions.config().newscatcher.key;
  const url = 'https://api.newscatcherapi.com/v2/latest_headlines?lang=en&when=7d';
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
      console.error(`Error from NewsCatcher API: ${response.statusText}`);
      throw new Error(`API request failed with status ${response.status}`);
    }

    const result = await response.json();
    console.log("Data received from NewsCatcher API:", result);

    const filteredArticles = result.articles.filter(article =>
      article.title.includes('Israel') || article.title.includes('Israeli')
    );

    console.log("Filtered articles:", filteredArticles);

    const db = admin.database();
    const ref = db.ref('news');
    const promises = filteredArticles.map(article => {
      console.log("Writing article to Firebase:", article.title);
      return ref.push({
        title: article.title,
        summary: article.summary,
        link: article.link,
        timestamp: Date.now(),
        score: null 
      });
    });

    await Promise.all(promises); // Wait for all database writes to complete

    console.log("All articles written to Firebase successfully.");
    res.set('Access-Control-Allow-Origin', '*');
    res.status(200).send({ message: "News stored successfully" });
  } catch (error) {
    console.error('Error occurred:', error.message);
    res.status(500).send('Error fetching news articles');
  }
});