"""Safe installation and cleanup of experiment-owned files."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from ...pipeline.exceptions import InstallationConflictError


@dataclass(slots=True)
class InstallSession:
    """Tracks files and directories created by a single experiment."""

    files: list[Path] = field(default_factory=list)
    directories: list[Path] = field(default_factory=list)
    backups: dict[Path, bytes] = field(default_factory=dict)

    def _ensure_parent(self, destination: Path) -> None:
        missing: list[Path] = []
        cursor = destination.parent
        while not cursor.exists():
            missing.append(cursor)
            cursor = cursor.parent
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.directories.extend(reversed(missing))

    def _backup_existing(self, destination: Path) -> None:
        if not destination.exists() or destination.is_dir():
            return
        if destination not in self.files and destination not in self.backups:
            self.backups[destination] = destination.read_bytes()

    def install_file(
        self,
        source: Path,
        destination: Path,
        *,
        overwrite: bool = False,
    ) -> None:
        if destination.exists() and not overwrite:
            raise InstallationConflictError(
                f"Refusing to overwrite existing file: {destination}"
            )

        self._ensure_parent(destination)

        if destination.exists():
            self._backup_existing(destination)
            destination.unlink()
        shutil.copy2(source, destination)
        if destination not in self.files:
            self.files.append(destination)

    def write_bytes(
        self,
        destination: Path,
        data: bytes,
        *,
        overwrite: bool = True,
    ) -> None:
        """Create or overwrite a file while tracking cleanup/backups."""

        if destination.exists() and not overwrite:
            raise InstallationConflictError(
                f"Refusing to overwrite existing file: {destination}"
            )

        self._ensure_parent(destination)
        self._backup_existing(destination)
        destination.write_bytes(data)
        if destination not in self.files:
            self.files.append(destination)

    def write_text(
        self,
        destination: Path,
        text: str,
        *,
        encoding: str = "utf-8",
        overwrite: bool = True,
    ) -> None:
        self.write_bytes(
            destination,
            text.encode(encoding),
            overwrite=overwrite,
        )

    def delete_path(self, destination: Path) -> None:
        """Delete a path; restore pre-experiment file bytes on cleanup when needed.

        Pre-existing directories are removed without byte restore (rmtree only).
        """

        if destination.is_dir():
            shutil.rmtree(destination)
            return

        if destination.exists():
            self._backup_existing(destination)
            destination.unlink(missing_ok=True)

        if destination in self.backups:
            if destination not in self.files:
                self.files.append(destination)
        elif destination in self.files:
            self.files = [path for path in self.files if path != destination]

    def cleanup(self) -> None:
        for path in reversed(self.files):
            backup = self.backups.get(path)
            try:
                if backup is not None:
                    self._ensure_parent(path)
                    path.write_bytes(backup)
                else:
                    path.unlink(missing_ok=True)
            except OSError:
                continue

        for path in reversed(self.directories):
            try:
                path.rmdir()
            except OSError:
                continue

        self.files.clear()
        self.directories.clear()
        self.backups.clear()
