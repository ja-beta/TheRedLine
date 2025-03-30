from flask import Flask
from firebase_init import db
import firebase_admin
from firebase_admin import credentials
from firebase_admin import firestore
from config import KEYWORDS, NEWS_COLLECTION, MAX_ARTICLES_PER_SITE
import requests
from bs4 import BeautifulSoup
import time
from requests.exceptions import RequestException, Timeout
import random
import os  

app = Flask(__name__)


NEWS_SITES = {
    "BBC": {
        "url": "https://www.bbc.com/news",
        "article_link_pattern": "/news/",
        "base_url": "https://www.bbc.com"
    },
    "AP News": {
        "url": "https://apnews.com/hub/world-news",
        "article_link_pattern": "/article/",
        "base_url": "https://apnews.com"
    },
    "The Guardian": {
        "url": "https://www.theguardian.com/world",
        "article_link_pattern": "/world/",
        "base_url": "https://www.theguardian.com"
    },
    # "Times of Israel": {
    #     "url": "https://www.timesofisrael.com/",
    #     "article_link_pattern": "/",
    #     "base_url": "https://www.timesofisrael.com"
    # },
    "Jerusalem Post": {
        "url": "https://www.jpost.com/",
        "article_link_pattern": "/",
        "base_url": "https://www.jpost.com"
    },
    # "Reuters Middle East": {
    #     "url": "https://www.reuters.com/world/middle-east/",
    #     "article_link_pattern": "/world/middle-east/",
    #     "base_url": "https://www.reuters.com"
    # },
}

def get_article_links(site_name, site_config, timeout=10, max_retries=3):
    """Scrapes article links with retries and error handling"""
    print(f"Scraping {site_name}...")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
    }
    
    session = requests.Session()
    
    for attempt in range(max_retries):
        try:
            # Add random delay between retries
            if attempt > 0:
                delay = random.uniform(2, 5)
                print(f"Retry {attempt + 1}/{max_retries} after {delay:.1f} seconds...")
                time.sleep(delay)
            
            response = session.get(
                site_config["url"], 
                headers=headers,
                timeout=timeout,
                allow_redirects=True
            )
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, "html.parser")
            links = []
            
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if site_config["article_link_pattern"] in href:
                    full_url = href if href.startswith("http") else f"{site_config['base_url']}{href}"
                    links.append(full_url)
            
            unique_links = list(set(links))
            print(f"Found {len(unique_links)} unique articles on {site_name}")
            return unique_links
            
        except Timeout:
            print(f"Timeout while scraping {site_name}")
        except RequestException as e:
            print(f"Network error while scraping {site_name}: {e}")
        except Exception as e:
            print(f"Unexpected error scraping {site_name}: {e}")
    
    print(f"Failed to scrape {site_name} after {max_retries} attempts")
    return []

def scrape_article(url, site_name, timeout=10):
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        }
        
        response = requests.get(url, headers=headers, timeout=timeout)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        
        title_element = soup.find("h1")
        title = title_element.text.strip() if title_element else "No title"
        
        invalid_titles = {
            "Business", "Climate", "Sport", "Technology", "Entertainment",
            "NewsNews",
            "Analysis", "Art & Design", "Movies", "Review",
            "Menu", "Navigation", "Search"
        }
        
        if (title in invalid_titles or 
            len(title) < 10 or 
            any(section in title for section in ["Section", "Category", "Page"])):
            print(f"Skipping article with invalid title: {title}")
            return None
        
        paragraphs = [p.text.strip() for p in soup.find_all("p") if len(p.text.strip()) > 50]
        content = " ".join(paragraphs[:2])  
        
        if len(content) < 200:
            print(f"Skipping article with insufficient content: {title}")
            return None
            
        return {"url": url, "title": title, "content": content}
    
    except Exception as e:
        print(f"Error scraping article {url}: {e}")
        return None

def search_keywords(article):
    """Checks if article contains any target keywords."""
    if not article:
        return False
        
    content = article["content"].lower()
    title = article["title"].lower()
    
    matches = {kw for kw in KEYWORDS if kw.lower() in content or kw.lower() in title}
    
    if matches:
        print(f"Found keywords {matches} in article: {article['title']}")
        return True
    return False

def get_content_start(content, words=10):
    """Get first N words of content for comparison"""
    words_list = content.split()
    return ' '.join(words_list[:words]).lower()

def store_article(article, source):
    """Store article in Firebase"""
    try:
        content_start = get_content_start(article["content"])
        
        existing_articles = db.get()  
        
        if existing_articles:
            for article_id, existing in existing_articles.items():
                if 'content' in existing:
                    existing_start = get_content_start(existing['content'])
                    if existing_start == content_start:
                        print(f"Duplicate article found. Skipping: {article['title']}")
                        return False

        article_data = {
            "title": article["title"],
            "content": article["content"],
            "link": article["url"],
            "source": source,
            "timestamp": int(time.time() * 1000),
            "processed": "pending"
        }
        
        db.push(article_data)  
        print(f"Stored article: {article['title']}")
        return True
        
    except Exception as e:
        print(f"Error storing article: {e}")
        return False

def scrape_news():
    articles_processed = 0
    sites_list = list(NEWS_SITES.items())
    sites_tried = set()
    
    while len(sites_tried) < len(sites_list) and articles_processed == 0:
        remaining_sites = [(name, config) for name, config in sites_list if name not in sites_tried]
        site_name, site_config = random.choice(remaining_sites)
        sites_tried.add(site_name)
        
        try:
            print(f"\nProcessing {site_name}...")
            article_links = get_article_links(site_name, site_config)
            random.shuffle(article_links)  
            
            print(f"Found {len(article_links)} articles, will process until we find one relevant article")
            
            for link in article_links:
                try:
                    print(f"\nChecking article from {site_name}")
                    time.sleep(2)  # Be nice to the servers
                    
                    article = scrape_article(link, site_name)
                    if article and search_keywords(article):
                        if store_article(article, site_name):
                            articles_processed += 1
                            print(f"Successfully processed and stored article: {article['title']}")
                            return articles_processed  # Exit after finding one article
                        else:
                            print(f"Duplicate article found, continuing search...")
                    else:
                        print(f"Skipping article - no relevant keywords or invalid content")
                            
                except Exception as e:
                    print(f"Error processing article {link}: {e}")
                    continue
                
            print(f"\nCompleted {site_name}: No new relevant articles found")
            
        except Exception as e:
            print(f"Error processing site {site_name}: {e}")
            continue
    
    print(f"\nScript completed. Processed {articles_processed} new articles.")
    return articles_processed

@app.route('/', methods=['GET']) 
def run_scraper():
    print("Scraping function triggered!") 
    news = scrape_news()
    if news:
        return "Scraping completed and data stored in Firestore", 200 
    else:
        return "Scraping failed", 500 

if __name__ == '__main__':
    app.run(debug=False, host="0.0.0.0", port=int(os.environ.get("PORT", 8080))) 
