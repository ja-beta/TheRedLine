# Use the official Python image as a base
FROM python:3.9-slim-buster

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file and install dependencies
COPY scraping/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

# Copy the scraping scripts
COPY scraping/ .

# Set the command to run when the container starts
CMD ["python", "scraper.py"]