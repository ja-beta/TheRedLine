const functions = require('firebase-functions/v2');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const referenceTexts = {
  best: [
      "Peace celebration: Smiling children playing together in sunny playground. Families sharing meals across tables. Open gates with flowers. Medical teams helping everyone. Green parks full of picnics.",
      
      "Community gathering: Markets bustling with shoppers. Students studying together in libraries. Sports teams playing friendly matches. Doctors treating patients in clean hospitals. Gardens growing fresh food.",
      
      "Daily life: Parents walking children to school. Shops open for business. Ambulances reaching patients quickly. Clean water flowing from taps. Fresh bread at local bakeries."
  ],
  worst: [
      "War damage: Smoking ruins of bombed buildings. Empty streets with debris. Destroyed ambulances. Dark windows in abandoned homes. Broken playground equipment.",
      
      "Crisis scene: Collapsed buildings in rubble. Blocked roads with wreckage. Damaged hospitals without power. Empty market stalls. Broken water pipes.",
      
      "Destruction: Missile damage to homes. Blocked emergency vehicles. Damaged power lines. Empty schools with broken windows. Destroyed infrastructure."
  ]
};

let embeddingBest = null;
let embeddingWorst = null;


async function initializeApp() {
  console.log("Initializing reference embeddings...");
  try {
    const { bestAvg, worstAvg, clusterAnalysis } = await generateReferenceEmbeddings();

    embeddingBest = bestAvg;
    embeddingWorst = worstAvg;
    
    if (!clusterAnalysis.isValid) {
      console.warn("WARNING: Reference embeddings may not be reliable:", clusterAnalysis.issues);
    }

    console.log("Cluster Analysis Results:", {
      bestCluster: {
        internalSimilarity: clusterAnalysis.bestCluster.internalSimilarity,
        centerDistance: clusterAnalysis.bestCluster.centerDistance
      },
      worstCluster: {
        internalSimilarity: clusterAnalysis.worstCluster.internalSimilarity,
        centerDistance: clusterAnalysis.worstCluster.centerDistance
      },
      clusterSeparation: clusterAnalysis.clusterSeparation
    });

    return {
      bestAvg,
      worstAvg,
      clusterAnalysis
    };
  } catch (error) {
    console.error("Failed to initialize reference embeddings:", error);
    throw error;
  }
}

admin.initializeApp();
initializeApp().catch(console.error);



async function generateReferenceEmbeddings() {
  try {
    const bestEmbeddings = await Promise.all(
      referenceTexts.best.map(text => askEmbedding(text))
    );
    const worstEmbeddings = await Promise.all(
      referenceTexts.worst.map(text => askEmbedding(text))
    );

    const normalizedBest = bestEmbeddings.map(normalizeEmbedding);
    const normalizedWorst = worstEmbeddings.map(normalizeEmbedding);

    let bestAvg = normalizeEmbedding(averageEmbeddings(normalizedBest));
    let worstAvg = normalizeEmbedding(averageEmbeddings(normalizedWorst));

    const amplificationFactor = 10.0; 
    const amplified = amplifyEmbeddingDifferences(bestAvg, worstAvg, amplificationFactor);
    bestAvg = amplified.bestAvg;
    worstAvg = amplified.worstAvg;

    const clusterAnalysis = analyzeEmbeddingClusters(normalizedBest, normalizedWorst, bestAvg, worstAvg);

    return { bestAvg, worstAvg, clusterAnalysis };
  } catch (error) {
    console.error("Error generating reference embeddings:", error);
    throw error;
  }
}

function averageEmbeddings(embeddings) {
  const length = embeddings[0].length;
  const sum = new Array(length).fill(0);

  embeddings.forEach(embedding => {
    embedding.forEach((value, index) => {
      sum[index] += value;
    });
  });

  return sum.map(value => value / embeddings.length);
}

exports.fetchNews = functions.https.onRequest(async (req, res) => {
  const API_KEY = process.env.NEWSCATCHER_API_KEY;

  if (!API_KEY) {
    console.error("NewsCatcher API key is missing.");
    res.status(500).send("Internal Server Error: API key is missing.");
    return;
  }

  const url = 'https://api.newscatcherapi.com/v2/latest_headlines?lang=en&when=24h&page_size=100&topic=news';

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

    const filteredArticles = result.articles.filter(article => {
      const summary = article.summary.toLowerCase();
      const matches = summary.includes('israel') || summary.includes('israeli');
      if (matches) {
        console.log(`Article matches criteria: ${article.title}`);
      }
      return matches;
    });
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

      // const articleRef = await ref.push({
      //   title: article.title,
      //   summary: article.summary,
      //   link: article.link,
      //   timestamp: Date.now(),
      //   score: "pending",
      // });

      // const prompt = `Please provide a sentiment analysis score for the following text: "${article.summary}". When calculating the score, consider the greater good of people living in the geographic region known as Israel / Palestine and the impact that's described in the text could have over their future. The score must be a floating point number between 0 and 1 (0 is negative sentiment and 1 is positive sentiment) with up to 6 decimal places. The answer should only contain the number, no additional characters, spaces, or line breaks.`;
      // await askValue(prompt, articleRef.key);

      const articleRef = await ref.push({
        title: article.title,
        summary: article.summary,
        link: article.link,
        timestamp: Date.now(),
        score: "pending",
        embedding: [],
      });

      console.log(`New article created with key: ${articleRef.key}`);

      const cleanedSummary = article.summary.replace(/\s+/g, ' ').trim();
      const embedding = await askEmbedding(cleanedSummary);
      if (embedding && Array.isArray(embedding)) {
        console.log(`Valid embedding received for article ${articleRef.key}, length: ${embedding.length}`);
        await updateEmbeddingInFirebase(articleRef.key, embedding);
      } else {
        console.error(`Failed to get valid embedding for article ${articleRef.key}`);
        await articleRef.update({ embeddingStatus: 'failed' });
      }
    });

    await Promise.all(writePromises);
    console.log("All new articles written to Firebase successfully.");
    res.status(200).send({ message: "Articles stored successfully." });

  } catch (error) {
    console.error("Error in fetchNews function:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

//#region  ASK LLM
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
//#endregion

//#region  ASK EMBEDDING MODEL
async function askEmbedding(textInput) {
  console.log("askEmbeddingModel called with text length:", textInput.length);

  try {
    const data = {
      version: "75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a", // CLIP
      // version: "b6b7585c9640cd7a9572c6e129c9549d79c9c31f0d3fdce7baac7c67ca38f305", // Replicate allmpnet-base-a2
      input: {
        inputs: textInput,
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

    console.log("Making request to embedding API through proxy");
    const response = await fetch("https://replicate-api-proxy.glitch.me/create_n_get/", options);

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const result = await response.json();
    console.log("Embedding API response:", result);

    if (!result || !result.output || !Array.isArray(result.output)) {
      console.error("Invalid API response format:", result);
      return null;
    }

    if (result.output.length === 0) {
      console.error("Empty embedding array received");
      return null;
    }

    const embedding = result.output[0].embedding;

    console.log("Valid embedding received with length:", result.output.length);
    return embedding;

  } catch (error) {
    console.error("Error in askEmbedding:", error);
    return null;
  }
}
//#endregion


async function updateEmbeddingInFirebase(key, embedding) {
  try {
    console.log(`Attempting to update embedding for article ${key}`);

    if (!embedding || !Array.isArray(embedding)) {
      console.error(`Invalid embedding for article ${key}:`, embedding);
      return;
    }

    const newsRef = admin.database().ref(`news/${key}`);
    await newsRef.update({
      embedding: embedding, 
      embeddingUpdatedAt: Date.now()
    });

    console.log(`Embedding successfully updated in Firebase for article ${key}`);
    await calculateScore(key);
  } catch (error) {
    console.error(`Error updating embedding in Firebase for article ${key}:`, error);
  }
}

function cosineSimilarity(a, b) {
  try {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      console.error('Invalid inputs for cosine similarity:', {
        aIsArray: Array.isArray(a),
        bIsArray: Array.isArray(b),
        aLength: a?.length,
        bLength: b?.length
      });
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      console.error('Zero magnitude vector detected');
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  } catch (error) {
    console.error('Error in cosineSimilarity calculation:', error);
    return 0;
  }
}

async function calculateScore(key) {
  try {
    if (!embeddingBest || !embeddingWorst) {
      console.error("Reference embeddings not initialized");
      return;
    }
    const newsRef = admin.database().ref(`news/${key}`);
    const snapshot = await newsRef.once('value');
    const article = snapshot.val();

    if (!article.embedding) {
      console.error(`No embedding found for article ${key}`);
      return;
    }

    let embeddingArray;
    if (Array.isArray(article.embedding)) {
      embeddingArray = article.embedding;
    } else if (typeof article.embedding === 'object') {
      // Convert object format to array if needed
      embeddingArray = Object.values(article.embedding).filter(value => typeof value === 'number');
    }

    console.log(`Article ${key} embedding stats:`, {
      length: embeddingArray.length,
      firstFew: embeddingArray.slice(0, 5),
      hasNaN: embeddingArray.some(isNaN)
    });

    console.log("Reference embeddings comparison:", {
      bestFirst5: embeddingBest.slice(0, 5),
      worstFirst5: embeddingWorst.slice(0, 5),
      similarityBetweenRefs: cosineSimilarity(embeddingBest, embeddingWorst)
    });

    if (embeddingArray.length !== embeddingBest.length) {
      console.error(`Embedding length mismatch for article ${key}:`, {
        articleLength: embeddingArray.length,
        expectedLength: embeddingBest.length
      });
      return;
    }

    const bestScore = cosineSimilarity(embeddingArray, embeddingBest);
    const worstScore = cosineSimilarity(embeddingArray, embeddingWorst);
    const normalizedScore = (bestScore - worstScore + 1) / 2;


    console.log(`Detailed score analysis for ${key}:`, {
      bestScore,
      worstScore,
      normalizedScore,
      confidence: Math.abs(bestScore - worstScore),
      interpretation: bestScore > worstScore
        ? `More similar to best case (${(bestScore * 100).toFixed(1)}% vs ${(worstScore * 100).toFixed(1)}%)`
        : `More similar to worst case (${(worstScore * 100).toFixed(1)}% vs ${(bestScore * 100).toFixed(1)}%)`,
      reliability: Math.abs(bestScore - worstScore) > 0.2
        ? "High"
        : "Low (scores too similar)"
    });

    await newsRef.update({
      score: normalizedScore,
      scoreDetails: {
        bestScore,
        worstScore,
        calculatedAt: Date.now()
      }
    });

    console.log(`Final score for article ${key}: ${normalizedScore}`);
    await calculateAndDisplayWeightedAverage();
  } catch (error) {
    console.error(`Error calculating score for article ${key}:`, error);
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

    if (article.score !== "pending") {
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
function normalizeEmbedding(embedding) {
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map(val => val / magnitude);
}

async function generateReferenceEmbeddings() {
  try {
    const bestEmbeddings = await Promise.all(
      referenceTexts.best.map(text => askEmbedding(text))
    );
    const worstEmbeddings = await Promise.all(
      referenceTexts.worst.map(text => askEmbedding(text))
    );

    // Normalize all embeddings
    const normalizedBest = bestEmbeddings.map(normalizeEmbedding);
    const normalizedWorst = worstEmbeddings.map(normalizeEmbedding);

    // Calculate centers after normalization
    const bestAvg = normalizeEmbedding(averageEmbeddings(normalizedBest));
    const worstAvg = normalizeEmbedding(averageEmbeddings(normalizedWorst));

    // Pass normalized embeddings and centers to analysis
    const clusterAnalysis = analyzeEmbeddingClusters(normalizedBest, normalizedWorst, bestAvg, worstAvg);

    return { bestAvg, worstAvg, clusterAnalysis };
  } catch (error) {
    console.error("Error generating reference embeddings:", error);
    throw error;
  }
}

function analyzeEmbeddingClusters(bestEmbeddings, worstEmbeddings, bestAvg, worstAvg) {
  // Calculate internal similarities within each cluster
  const bestInternalSims = calculateInternalSimilarities(bestEmbeddings);
  const worstInternalSims = calculateInternalSimilarities(worstEmbeddings);

  // Calculate distances from points to their centers
  const bestCenterDists = bestEmbeddings.map(emb => cosineSimilarity(emb, bestAvg));
  const worstCenterDists = worstEmbeddings.map(emb => cosineSimilarity(emb, worstAvg));

  // Calculate cross-cluster separation (distance between centers)
  const centerSeparation = 1 - cosineSimilarity(bestAvg, worstAvg);

  // Calculate average similarities
  const analysis = {
    bestCluster: {
      internalSimilarity: average(bestInternalSims),
      centerDistance: average(bestCenterDists)
    },
    worstCluster: {
      internalSimilarity: average(worstInternalSims),
      centerDistance: average(worstCenterDists)
    },
    clusterSeparation: centerSeparation,  
    isValid: true,
    issues: []
  };

  if (analysis.clusterSeparation < 0.4) {  
    analysis.isValid = false;
    analysis.issues.push("Best and worst cases are too similar to each other");
  }

  return analysis;
}

function amplifyEmbeddingDifferences(bestAvg, worstAvg, amplificationFactor = 10.0) {
  // Calculate the midpoint
  const midpoint = averageEmbeddings([bestAvg, worstAvg]);
  
  // Calculate and normalize the direction vectors
  const bestVector = bestAvg.map((val, i) => val - midpoint[i]);
  const worstVector = worstAvg.map((val, i) => val - midpoint[i]);
  
  // Apply amplification with normalization at each step
  const amplifiedBest = normalizeEmbedding(
    bestAvg.map((val, i) => midpoint[i] + (bestVector[i] * amplificationFactor))
  );
  const amplifiedWorst = normalizeEmbedding(
    worstAvg.map((val, i) => midpoint[i] + (worstVector[i] * amplificationFactor))
  );
  
  return { bestAvg: amplifiedBest, worstAvg: amplifiedWorst };
}

function calculateInternalSimilarities(embeddings) {
  const similarities = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      similarities.push(cosineSimilarity(embeddings[i], embeddings[j]));
    }
  }
  return similarities;
}

function calculateCrossSimilarities(embeddingsA, embeddingsB) {
  const similarities = [];
  embeddingsA.forEach(embA => {
    embeddingsB.forEach(embB => {
      similarities.push(cosineSimilarity(embA, embB));
    });
  });
  return similarities;
}

function average(arr) {
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}