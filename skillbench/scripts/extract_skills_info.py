#!/usr/bin/env python3
"""
Script to extract all skill information from the tasks directory.
Extracts skill folders from environment/skills and copies them to a target directory.
"""

import shutil
import json
from pathlib import Path
import sys
from loguru import logger


def extract_skill_info(source_dir, target_dir):
    """
    Extract skill information from tasks directory and copy skill folders.

    Args:
        source_dir: Source directory containing task folders
        target_dir: Target directory to copy skill folders to
    """
    source_path = Path(source_dir)
    target_path = Path(target_dir)

    target_path.mkdir(parents=True, exist_ok=True)

    # Dictionary to store extracted information
    extracted_info = {
        "source_directory": str(source_path),
        "target_directory": str(target_path),
        "tasks_found": [],
        "skills_extracted": [],
        "errors": [],
    }

    # Check if source directory exists
    if not source_path.exists():
        logger.error(f"Source directory '{source_path}' does not exist")
        extracted_info["errors"].append(f"Source directory '{source_path}' does not exist")
        return extracted_info

    # Get all task folders
    task_folders = []
    for item in source_path.iterdir():
        if item.is_dir():
            task_folders.append(item)

    logger.info(f"Found {len(task_folders)} task folders in {source_path}")
    logger.debug("-" * 60)

    for task_folder in task_folders:
        task_name = task_folder.name
        extracted_info["tasks_found"].append(task_name)

        logger.info(f"Processing task: {task_name}")

        # Check for environment/skills directory
        skills_dir = task_folder / "environment" / "skills"

        if skills_dir.exists() and skills_dir.is_dir():
            logger.debug(f"Found skills directory: {skills_dir}")

            # Get all skill folders in the skills directory
            skill_subfolders = []
            for item in skills_dir.iterdir():
                if item.is_dir():
                    skill_subfolders.append(item)

            if skill_subfolders:
                logger.debug(f"Found {len(skill_subfolders)} skill subfolder(s)")

                for skill_subfolder in skill_subfolders:
                    skill_name = skill_subfolder.name
                    target_skill_dir = target_path / skill_name

                    if target_skill_dir.exists():
                        logger.info(f"Skill '{skill_name}' already exists in target, skipping...")
                        extracted_info["skills_extracted"].append(
                            {
                                "skill_name": skill_name,
                                "source_task": task_name,
                                "status": "skipped (already exists)",
                                "source_path": str(skill_subfolder),
                                "target_path": str(target_skill_dir),
                            }
                        )
                        continue
                    else:
                        try:
                            # Copy the skill folder
                            logger.info(f"Copying '{skill_name}' to target...")
                            shutil.copytree(skill_subfolder, target_skill_dir)

                            extracted_info["skills_extracted"].append(
                                {
                                    "skill_name": skill_name,
                                    "source_task": task_name,
                                    "status": "copied",
                                    "source_path": str(skill_subfolder),
                                    "target_path": str(target_skill_dir),
                                }
                            )
                            logger.success(f"Successfully copied '{skill_name}'")
                        except Exception as e:
                            error_msg = f"Failed to copy '{skill_name}': {str(e)}"
                            logger.error(error_msg)
                            extracted_info["errors"].append(error_msg)
            else:
                logger.info(f"No skill subfolders found in {skills_dir}")
        else:
            logger.info(f"No skills directory found at {skills_dir}")

    # Print summary
    logger.info("=" * 60)
    logger.info("EXTRACTION SUMMARY")
    logger.info("=" * 60)
    logger.info(f"Source directory: {source_path}")
    logger.info(f"Target directory: {target_path}")
    logger.info(f"Total tasks processed: {len(task_folders)}")

    # Count extracted skills
    extracted_count = len([s for s in extracted_info["skills_extracted"] if s["status"] == "copied"])
    skipped_count = len([s for s in extracted_info["skills_extracted"] if s["status"].startswith("skipped")])

    logger.info(f"Skills extracted: {extracted_count}")
    logger.info(f"Skills skipped (already exist): {skipped_count}")

    if extracted_info["errors"]:
        logger.error(f"Errors encountered: {len(extracted_info['errors'])}")
        for error in extracted_info["errors"]:
            logger.error(f"  - {error}")

    # Save extraction info to JSON file
    info_file = target_path / "extraction_info.json"
    with open(info_file, "w") as f:
        json.dump(extracted_info, f, indent=2)

    logger.success(f"Extraction information saved to: {info_file}")

    return extracted_info


def main():
    """Main function to run the extraction."""
    if len(sys.argv) != 3:
        logger.error(f"Usage: {sys.argv[0]} <source_dir> <target_dir>")
        sys.exit(1)

    source_dir = sys.argv[1]
    target_dir = sys.argv[2]

    logger.info("Skill Information Extractor")
    logger.info("=" * 60)
    logger.info(f"Source: {source_dir}")
    logger.info(f"Target: {target_dir}")
    logger.info("=" * 60)

    # Run extraction
    result = extract_skill_info(source_dir, target_dir)

    # List extracted skills
    if result["skills_extracted"]:
        logger.info("Extracted Skills:")
        for skill in result["skills_extracted"]:
            logger.info(f"  {skill['skill_name']} (from: {skill['source_task']}) - {skill['status']}")


if __name__ == "__main__":
    main()
