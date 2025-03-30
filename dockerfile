# Use the official Python image as a base
FROM --platform=linux/amd64 python:3.9-slim

LABEL project="theredline-jn"
LABEL service="trl-scraper"
LABEL version="1.0.0"

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file and install dependencies
COPY scraping/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy all necessary files
COPY scraping/ ./scraping/
COPY config/ ./config/

# Set environment variables for project isolation
ENV GOOGLE_CLOUD_PROJECT=theredline-jn
ENV PROJECT_ID=theredline-jn

# Set the command to run when the container starts
CMD ["python", "scraping/scraper.py"]