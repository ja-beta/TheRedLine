import firebase_admin
from firebase_admin import credentials
from firebase_admin import db
from config import NEWS_COLLECTION

# Initialize Firebase
cred = credentials.Certificate('firebase-credentials.json')
firebase_admin.initialize_app(cred, {
    'databaseURL': 'https://theredline-jn-default-rtdb.firebaseio.com'
})

# Get database reference
db = db.reference(NEWS_COLLECTION)
