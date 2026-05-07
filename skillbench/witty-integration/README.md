To integrate opencode plugin into harbor task:
0) Launch witty-skill-insight instance
1) Copy .env.template into .env and fill it with the Skill-Insight API key and URL (note that Harbor tasks with their agent usually launch inside a container).
2) List the benchmark tasks in benchmark_tasks.yaml
3) Run prepare-benchmark-tasks.sh to copy selected tasks from skillbench/tasks_all into skillbench/tasks
4) If you want to rebuild skillbench/tasks from scratch, run prepare-benchmark-tasks.sh --clean
5) The same script will then copy opencode-integration.sh into task/environment as witty-setup.sh
6) The same script will also copy/add variables from .env to task/environment/.env
7) The same script will append Dockerfile.template code to task/environment/Dockerfile

prepare-benchmark-tasks.sh can do this work end-to-end for the selected tasks.
