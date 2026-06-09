#!/usr/bin/env python3
"""
Script for creating tasks_{mode} with optimized skills from the specified folder.
Uses extraction_info.json from the optimized skills folder for task-to-skill mapping.
Copies tasks from tasks to tasks_{mode}, replacing skills with optimized versions
from snapshots/v1 (excluding OPTIMIZATION_REPORT.md and diagnoses.json).
Supports modes: static, hybrid, dynamic, feedback.

Usage:
    python create_tasks_mode.py <TASKS_DIR> <OPTIMIZED_SKILLS_DIR> [--dest-dir DIR] [tasks...]
"""

import os
import json
import shutil
import sys
import re
from pathlib import Path

# Files excluded when copying snapshots/v1
EXCLUDE_FILES = {"OPTIMIZATION_REPORT.md", "diagnoses.json"}


def load_extraction_info(optimized_skills_dir):
    """Loads task-to-skill mapping from extraction_info.json in the specified folder."""
    extraction_info_path = optimized_skills_dir / "extraction_info.json"
    if not extraction_info_path.exists():
        print(f"extraction_info.json not found in {optimized_skills_dir}")
        return {}
    with open(extraction_info_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    task_to_skills = {}
    for skill_info in data.get("skills_extracted", []):
        task = skill_info.get("source_task")
        skill_name = skill_info.get("skill_name")
        if not task or not skill_name:
            continue
        if task not in task_to_skills:
            task_to_skills[task] = []
        if skill_name not in task_to_skills[task]:
            task_to_skills[task].append(skill_name)
    return task_to_skills


ALLOWED_MODES = ("static", "hybrid", "dynamic", "feedback")


def extract_mode_from_dirname(dir_path):
    """
    Extracts mode from the directory name.
    Expects name in format: ...optimized-<mode>-YYYYMMDD_HHMMSS
    Raises ValueError if the mode is missing or not one of: static, hybrid, dynamic.
    """
    dir_name = dir_path.name
    # Pattern: optimized-<mode>-timestamp
    pattern = r"optimized-([a-zA-Z]+)-\d{8}_\d{6}"
    match = re.search(pattern, dir_name)
    if match:
        mode = match.group(1).lower()
        if mode in ALLOWED_MODES:
            return mode
        raise ValueError(
            f"Unknown mode '{mode}' in directory name '{dir_name}'. "
            f"Allowed modes: {', '.join(ALLOWED_MODES)}."
        )

    # Alternative: search for mode substrings in the name
    for mode in ALLOWED_MODES:
        if mode in dir_name.lower():
            return mode

    raise ValueError(
        f"Could not determine mode from directory name '{dir_name}'. "
        f"Expected pattern '...optimized-<mode>-YYYYMMDD_HHMMSS' with mode "
        f"in {{{', '.join(ALLOWED_MODES)}}}."
    )


def copy_without_excluded(src_dir, dst_dir):
    """
    Copies contents of src_dir to dst_dir, excluding files from EXCLUDE_FILES.
    Uses shutil.copytree with an ignore function for recursive copying.
    """

    # Ignore function that excludes files with specified names at any level
    def ignore_func(dirpath, filenames):
        # Exclude files whose names are in EXCLUDE_FILES
        return [f for f in filenames if f in EXCLUDE_FILES]

    # dst_dir must not exist for copytree
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir, ignore=ignore_func)


def update_skill_name(skill_dir, new_name):
    """
    Updates the name: field in the SKILL.md file inside skill_dir.
    """
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return
    with open(skill_md, "r", encoding="utf-8") as f:
        content = f.read()
    lines = content.splitlines()
    updated = False
    for i, line in enumerate(lines):
        if line.strip().startswith("name:"):
            lines[i] = f"name: {new_name}"
            updated = True
            break
    if updated:
        with open(skill_md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"Updated skill name in SKILL.md to '{new_name}'")


def copy_task_with_optimized_skills(task_name, task_to_skills_map, optimized_skills_dir, dest_dir, tasks_dir, suffix=""):
    """
    Copies a task to dest_dir, replacing skills with optimized versions.
    suffix is appended to the skill name (e.g., "-static").
    """
    task_source = tasks_dir / task_name
    if not task_source.exists():
        print(f"Task {task_name} not found in {tasks_dir}")
        return

    task_dest = dest_dir / task_name
    # Remove old copy if it exists
    if task_dest.exists():
        shutil.rmtree(task_dest)

    # Copy the entire task
    shutil.copytree(task_source, task_dest)

    # Get the list of skills for this task
    skills = task_to_skills_map.get(task_name, [])
    if not skills:
        print(f"No skills found in mapping for task {task_name}.")
        return

    # For each skill, check for an optimized version
    for skill_name in skills:
        new_skill_name = skill_name + suffix
        skill_source_dir = task_dest / "environment" / "skills" / skill_name
        new_skill_dir = task_dest / "environment" / "skills" / new_skill_name

        # Check if the source skill exists (may not exist if suffix is non-empty and skill was already renamed)
        if not skill_source_dir.exists():
            print(f"Source skill {skill_name} not found in task {task_name}")
            # Continue, the skill may have already been renamed

        # Check if the skill folder exists in the optimized directory
        optimized_skill_dir = optimized_skills_dir / skill_name
        if not optimized_skill_dir.exists():
            print(f"Optimized skill {skill_name} not found in {optimized_skills_dir}, keeping original")
            continue

        # Check for snapshots/v1
        snapshot_v1 = optimized_skill_dir / "snapshots" / "v1"
        if not snapshot_v1.exists():
            print(f"Optimized skill {skill_name} has no snapshots/v1, keeping original")
            continue

        print(f"Found optimized skill: {skill_name} -> {new_skill_name}")

        # Remove old skill (if it exists)
        if skill_source_dir.exists():
            shutil.rmtree(skill_source_dir)
        # Remove new skill (if it already exists)
        if new_skill_dir.exists():
            shutil.rmtree(new_skill_dir)

        # Copy snapshots/v1 contents, excluding specified files
        copy_without_excluded(snapshot_v1, new_skill_dir)

        # Update name in SKILL.md
        update_skill_name(new_skill_dir, new_skill_name)

        print(f"Replaced skill {skill_name} with optimized version '{new_skill_name}'")

    print(f"Task {task_name} updated in {task_dest}")


def resolve_task_name(arg, tasks_dir):
    """Converts a command-line argument to a task name."""
    path = Path(arg)
    if path.is_absolute() or "/" in arg:
        try:
            path = path.resolve()
            if path.is_relative_to(tasks_dir):
                return path.name
            else:
                print(f"Warning: task {arg} is not in {tasks_dir}, using basename")
                return path.name
        except Exception:
            return path.name
    else:
        return arg


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Create tasks_{mode} with optimized skills (static/hybrid/dynamic/feedback)")
    parser.add_argument(
        "tasks_dir",
        help="Path to the directory with source tasks",
    )
    parser.add_argument(
        "optimized_dir",
        help="Path to the folder with optimized skills",
    )
    parser.add_argument(
        "--dest-dir",
        "-d",
        default=None,
        help="Target folder for tasks (default: tasks_{mode} next to TASKS_DIR)",
    )
    parser.add_argument(
        "tasks",
        nargs="*",
        help="List of tasks to process (paths or names). If not specified, all tasks are processed.",
    )
    args = parser.parse_args()

    tasks_dir = Path(args.tasks_dir).resolve()
    optimized_skills_dir = Path(args.optimized_dir).resolve()

    if not tasks_dir.exists():
        print(f"Tasks directory not found: {tasks_dir}")
        sys.exit(1)

    if not optimized_skills_dir.exists():
        print(f"Optimized skills folder not found: {optimized_skills_dir}")
        sys.exit(1)

    # Load task-to-skill mapping
    print(f"Loading extraction_info.json from {optimized_skills_dir}...")
    task_to_skills = load_extraction_info(optimized_skills_dir)
    print(f"Found {len(task_to_skills)} tasks with skill mapping.")

    # Determine mode and suffix for skill names
    try:
        mode = extract_mode_from_dirname(optimized_skills_dir)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    suffix = f"-{mode}"
    print(f"Mode: '{mode}', suffix: '{suffix}'")

    # Determine target directory — next to TASKS_DIR
    if args.dest_dir is None:
        dest_dir = tasks_dir.parent / f"tasks_{mode}"
    else:
        dest_dir = Path(args.dest_dir).resolve()

    # Determine which tasks to process
    if args.tasks:
        task_names = []
        for arg in args.tasks:
            task_name = resolve_task_name(arg, tasks_dir)
            task_names.append(task_name)
        valid_tasks = []
        for task in task_names:
            if (tasks_dir / task).exists():
                valid_tasks.append(task)
            else:
                print(f"Task {task} not found in {tasks_dir}")
        tasks = valid_tasks
    else:
        # Process all tasks in tasks_dir
        tasks = [d.name for d in tasks_dir.iterdir() if d.is_dir()]
        print(f"Found {len(tasks)} tasks in {tasks_dir}")

    # Create target folder if it doesn't exist
    dest_dir.mkdir(parents=True, exist_ok=True)

    for task_name in tasks:
        print(f"\nProcessing task: {task_name}")
        copy_task_with_optimized_skills(task_name, task_to_skills, optimized_skills_dir, dest_dir, tasks_dir, suffix)

    print(f"\nDone! Tasks with {mode} skills created in {dest_dir}")


if __name__ == "__main__":
    main()
