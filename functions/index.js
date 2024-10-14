//#region // API + Firebase
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
  
    const url = 'https://api.newscatcherapi.com/v2/latest_headlines?lang=en&countries=US&topic=world';
  
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
        article.title.includes('Israel') || article.title.includes('Israeli')
      );
      console.log("Filtered articles:", filteredArticles);
  
      if (filteredArticles.length === 0) {
        console.warn("No articles found that match the criteria.");
        res.status(200).send({ message: "No articles matching the criteria." });
        return;
      }
  
      const ref = admin.database().ref('news');
  
      const writePromises = filteredArticles.map(async (article) => {
        console.log("Checking for existing article:", article.title);
  
        const existingArticleSnapshot = await ref.orderByChild('title').equalTo(article.title).once('value');
        if (existingArticleSnapshot.exists()) {
          console.log(`Article "${article.title}" already exists. Skipping...`);
          return;
        }
  
        console.log("Writing new article to Firebase:", article.title);
        return ref.push({
          title: article.title,
          summary: article.summary,
          link: article.link,
          timestamp: Date.now(),
          score: "pending",
        });
      });
  
      await Promise.all(writePromises);
      console.log("All new articles written to Firebase successfully.");
      res.status(200).send({ message: "Articles stored successfully." });
  
    } catch (error) {
      console.error("Error in fetchNews function:", error.message);
      res.status(500).send("Internal Server Error");
    }
  });
  


//#endregion

//#region Dummy test for Firebase
// const functions = require('firebase-functions');
// const admin = require('firebase-admin');

// admin.initializeApp();

// exports.pushDummyData = functions.https.onRequest(async (req, res) => {
//   const db = admin.database();
//   const ref = db.ref('news');

//   const dummyData = {
//     article1: {
//       title: "Test Article 1",
//       summary: "This is a test summary for article 1",
//       link: "https://example.com/article1",
//       timestamp: Date.now(),
//       score: null
//     },
//     article2: {
//       title: "Test Article 2",
//       summary: "This is a test summary for article 2",
//       link: "https://example.com/article2",
//       timestamp: Date.now(),
//       score: null
//     }
//   };

//   try {
//     await ref.set(dummyData);
//     console.log("Dummy data written successfully");
//     res.status(200).send({ message: "Dummy data stored successfully" });
//   } catch (error) {
//     console.error("Error writing dummy data:", error);
//     res.status(500).send({ message: "Error storing dummy data", error: error.message });
//   }
// });

//#endregion