import json
import os
import shutil
import zipfile
from pathlib import Path

import requests
from dotenv import load_dotenv
from loguru import logger

# Anchor all paths to the skillbench root (parent of scripts/), not CWD,
# so the script behaves the same regardless of where it's invoked from.
SKILLBENCH_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(SKILLBENCH_ROOT / ".env")
logger.remove()
logger.add(
    sink=lambda msg: print(msg, end=""),
    format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
    level="INFO"
)

def main():
    """Main function to execute the download process."""
    logger.info("=" * 60)
    logger.info("Starting SkillBench Download Script")
    logger.info("=" * 60)

    # Configuration
    owner = "benchflow-ai"
    repo = "skillsbench"
    branch = "main"  # or "master"
    token = os.environ.get("GITHUB_TOKEN")  # Set your token as environment variable

    logger.info(f"Downloading {repo} repository from {owner}/{repo}:{branch}")

    # Correct URL for downloading a branch as ZIP
    url = f"https://api.github.com/repos/{owner}/{repo}/zipball/{branch}"
    logger.debug(f"Download URL: {url}")

    headers = {
        "Accept": "application/vnd.github.v3+json"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
        logger.info("Using GitHub token for authentication")
    else:
        logger.warning("No GitHub token found - using public API rate limits")

    logger.info("Initiating download request...")
    try:
        response = requests.get(url, headers=headers, stream=True, allow_redirects=True, timeout=30)
    except requests.exceptions.Timeout:
        logger.error("Request timed out after 30 seconds")
        return
    except requests.exceptions.RequestException as e:
        logger.error(f"Request failed: {e}")
        return

    if response.status_code == 200:
        zip_filename = str(SKILLBENCH_ROOT / f"{repo}-{branch}.zip")
        logger.info(f"Download successful (status {response.status_code}), saving to {zip_filename}")

        total_size = int(response.headers.get('content-length', 0))
        if total_size:
            logger.info(f"Total download size: {total_size / 1024 / 1024:.2f} MB")

        downloaded = 0
        with open(zip_filename, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
                downloaded += len(chunk)
                if total_size and downloaded % (1024 * 1024) == 0:  # Log every 1MB
                    progress = (downloaded / total_size) * 100
                    logger.info(f"Download progress: {downloaded / 1024 / 1024:.1f} MB / {total_size / 1024 / 1024:.1f} MB ({progress:.1f}%)")

        logger.success(f"Download completed: {zip_filename} ({downloaded / 1024 / 1024:.2f} MB)")

        extract_dir = str(SKILLBENCH_ROOT / f"{repo}-{branch}")
        tasks_dest = str(SKILLBENCH_ROOT / "tasks")

        logger.info(f"Starting extraction of {zip_filename} to {extract_dir}")
        with zipfile.ZipFile(zip_filename, 'r') as zip_ref:
            file_list = zip_ref.namelist()
            logger.info(f"Archive contains {len(file_list)} files")
            zip_ref.extractall(extract_dir)
        logger.success(f"Extraction completed to {extract_dir}")

        # Find and copy tasks folder
        logger.info("Searching for tasks folder in extracted contents...")
        tasks_found = False
        for root, dirs, _ in os.walk(extract_dir):
            if 'tasks' in dirs:
                tasks_src = os.path.join(root, 'tasks')
                logger.info(f"Found tasks folder at: {tasks_src}")

                if os.path.exists(tasks_dest):
                    logger.warning(f"Destination {tasks_dest} already exists, removing...")
                    shutil.rmtree(tasks_dest)

                logger.info(f"Copying tasks folder to {tasks_dest}")
                shutil.copytree(tasks_src, tasks_dest)
                logger.success(f"Copied tasks folder to {tasks_dest}")

                # Build tasks_index.json
                logger.info("Building tasks index...")
                task_dirs = sorted([
                    d for d in os.listdir(tasks_dest)
                    if os.path.isdir(os.path.join(tasks_dest, d))
                ])
                tasks_index = {name: i for i, name in enumerate(task_dirs)}
                index_path = os.path.join(tasks_dest, "tasks_index.json")
                with open(index_path, "w", encoding="utf-8") as f:
                    json.dump(tasks_index, f, indent=2, ensure_ascii=False)
                logger.success(f"Created {index_path} with {len(tasks_index)} tasks")
                logger.debug(f"Index content: {tasks_index}")

                tasks_found = True
                break

        if not tasks_found:
            logger.error("No tasks folder found in the downloaded repository!")
            logger.info("Available directories in extracted content:")
            for root, dirs, _ in os.walk(extract_dir):
                if dirs:
                    logger.info(f"  {root}: {dirs}")

        # Cleanup
        logger.info("Starting cleanup phase...")

        if os.path.exists(zip_filename):
            os.remove(zip_filename)
            logger.info(f"Deleted temporary zip file: {zip_filename}")
        else:
            logger.warning(f"Zip file {zip_filename} not found for cleanup")
        if os.path.exists(extract_dir):
            shutil.rmtree(extract_dir)
            logger.info(f"Deleted temporary extraction directory: {extract_dir}")
        else:
            logger.warning(f"Extraction directory {extract_dir} not found for cleanup")

        logger.success("=" * 60)
        logger.success("Download and extraction process completed successfully!")
        logger.success("=" * 60)

    elif response.status_code == 404:
        logger.error(f"Download failed with status {response.status_code}: Branch or repository not found")
        logger.info("Check the branch name and repository.")
        logger.info("Otherwise you can download manually from https://github.com/benchflow-ai/skillsbench")
    elif response.status_code == 401:
        logger.error(f"Download failed with status {response.status_code}: Authentication failed")
        logger.info("Check your GitHub token.")
        logger.info("Otherwise you can download manually from https://github.com/benchflow-ai/skillsbench")
    else:
        logger.error(f"Download failed with status {response.status_code}")
        logger.info("Otherwise you can download manually from https://github.com/benchflow-ai/skillsbench")


if __name__ == "__main__":
    main()
