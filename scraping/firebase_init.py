import firebase_admin
from firebase_admin import credentials
from firebase_admin import db
import os
import json

# Get the current directory
current_dir = os.path.dirname(os.path.abspath(__file__))

# Path to the service account key file
cred_path = os.path.join(current_dir, 'firebase-credentials.json')
if not os.path.exists(cred_path):
    cred_path = os.path.join(current_dir, 'scraping/firebase-credentials.json')
    if not os.path.exists(cred_path):
        if 'FIREBASE_CONFIG' in os.environ:
            firebase_config = json.loads(os.environ.get('FIREBASE_CONFIG'))
            with open(cred_path, 'w') as f:
                json.dump(firebase_config, f)
        else:
            raise FileNotFoundError(f"Firebase credentials file not found at {cred_path}")

# Load settings from central config
config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'config', 'settings.json')
with open(config_path) as f:
    settings = json.load(f)

# Use settings
db_collection = settings['database']['collection']
db_url = settings['database']['url']

# Initialize Firebase app
cred = credentials.Certificate(cred_path)
firebase_admin.initialize_app(cred, {
    'databaseURL': db_url
})

# Get a reference to the database
db = db.reference(db_collection) 