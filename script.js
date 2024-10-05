import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase, ref, onValue, update, set, onChildAdded, onChildChanged } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";
import { firebaseConfig, apiUrl, nytApiKey } from './config.js';

let db;

document.addEventListener("DOMContentLoaded", () => {
    const inputField = document.getElementById("input-query");
    const submitButton = document.getElementById("submit-query");
    const meterElement = document.getElementById("meter");
    const meterLabelVal = document.getElementById("the-score");

    submitButton.addEventListener("click", () => {
        const query = inputField.value;
        addQuery(query);
        inputField.value = "";
    });

    function updateMeter(average) {
        console.log("Updating meter with average:", average);
        meterElement.value = average;
        meterLabelVal.textContent = average.toFixed(6);
    }

    initFirebaseDB();
    subscribeToData();
    subscribeToScoreUpdates();
    callNytApi();

    function initFirebaseDB() {
        const app = initializeApp(firebaseConfig);
        db = getDatabase();
    }

    function subscribeToData() {
        const folder = "items";
        const thisRef = ref(db, folder);

        onChildAdded(thisRef, (snapshot) => {
            const latestEntry = snapshot.val();
            console.log("Latest entry:", latestEntry);

            if (latestEntry && latestEntry.line && !latestEntry.score) {
                const prompt = `Please perform sentiment analysis on the following text: ${latestEntry.line}. Provide a score between 0 and 1, 0 being negative and 1 being positive. The number is a float of up to 6 decimal places. Your response should be the score number only.`;
                askValue(prompt, snapshot.key);
            }
        });
    }

    async function askValue(prompt, key) {
        document.body.style.cursor = "progress";
        const data = {
            modelURL: "https://api.replicate.com/v1/models/meta/meta-llama-3-70b-instruct/predictions",
            input: {
                prompt: prompt,
            },
        };
        console.log("Making a Request", data);
        const options = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: 'application/json',
            },
            body: JSON.stringify(data),
        };

        try {
            const response = await fetchWithTimeout(apiUrl, options, 600000); // 10 minutes timeout
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();

            console.log("Full response from API:", result);

            if (!result.output || result.output.length === 0) {
                console.log("Something went wrong, try it again");
            } else {
                console.log("Returned from API", result);
                const score = result.output.join('').trim();
                updateScoreInFirebase(key, parseFloat(score));
            }
        } catch (error) {
            console.error("Error fetching data:", error);
        } finally {
            document.body.style.cursor = "auto";
        }
    }

    function updateScoreInFirebase(key, score) {
        const folder = "items";
        const dbRef = ref(db, `${folder}/${key}`);
        update(dbRef, { score: score })
            .then(() => {
                console.log("Score updated successfully");
            })
            .catch((error) => {
                console.error("Error updating score:", error);
            });
    }

    async function fetchWithTimeout(resource, options, timeout = 30000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    }

    function addQuery(query) {
        const folder = "items";
        const thisRef = ref(db, folder);

        onValue(thisRef, (snapshot) => {
            const data = snapshot.val();
            const keys = Object.keys(data || {});
            const nextKey = keys.length.toString();

            const newEntry = {
                line: query,
                score: null,
                timestamp: new Date().toISOString(),
            };

            const newRef = ref(db, `${folder}/${nextKey}`);
            set(newRef, newEntry).then(() => {
                console.log("Query added successfully");
            })
                .catch((error) => {
                    console.error("Error adding query:", error);
                });
        }, {
            onlyOnce: true
        });
    }

    function subscribeToScoreUpdates() {
        const folder = "items";
        const thisRef = ref(db, folder);

        onChildChanged(thisRef, (snapshot) => {
            const updatedEntry = snapshot.val();

            if (updatedEntry && typeof updatedEntry.score === "number") {
                calculateAndDisplayAverage();
            }
        });
    }

    function calculateAndDisplayAverage() {
        const folder = "items";
        const thisRef = ref(db, folder);

        onValue(thisRef, (snapshot) => {
            const data = snapshot.val();
            const keys = Object.keys(data || {});
            const totalScores = keys.reduce((sum, key) => sum + (data[key].score || 0), 0);
            const average = totalScores / keys.length;

            console.log("Calculated average score:", average);
            updateMeter(average);
        }, {
            onlyOnce: true
        });
    }

    // NYTimes API ______________________________________________________________________________________

    function callNytApi() {
        fetchNytArticles();
        setInterval(() => {
            fetchNytArticles();
        }, 300000); // 5 minutes
    }

    async function fetchNytArticles() {
        const nytApiUrl = `https://api.nytimes.com/svc/news/v3/content/nyt/world.json?api-key=${nytApiKey}`;
        try {
            const response = await fetch(nytApiUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            const articles = data.results;

            articles.forEach(article => {
                if (article.abstract) {
                    addQuery(article.abstract);
                }

                const nytIndicator = document.getElementById("nyt-indicator");
                nytIndicator.style.backgroundColor = "red";
                setTimeout(() => {
                    nytIndicator.style.backgroundColor = "lightgray";
                }, 5000);
            });
        } catch (error) {
            console.error("Error fetching data:", error);
        }
    }
});