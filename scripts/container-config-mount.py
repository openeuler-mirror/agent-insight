"""Read a host-owned private bind mount, then run the application as the image user."""
import os
import pwd
import stat
import tempfile


def main():
    file = os.environ['AGENT_INSIGHT_STORAGE_CONFIG']
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        mode = os.fstat(fd).st_mode
        if not stat.S_ISREG(mode) or mode & 0o077:
            raise SystemExit('数据库配置必须是 0600 私有普通文件')
        content = source.read(1024 * 1024 + 1)
        if len(content) > 1024 * 1024:
            raise SystemExit('数据库配置文件过大')
    user = pwd.getpwnam('node')
    os.setgroups([])
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    os.environ['HOME'] = user.pw_dir
    with tempfile.NamedTemporaryFile(dir='/tmp', prefix='storage-', delete=False) as copy:
        copy.write(content)
    os.environ['AGENT_INSIGHT_STORAGE_CONFIG'] = copy.name
    os.environ['AGENT_INSIGHT_STORAGE_CONFIG_SOURCE'] = file
    os.execv('/usr/local/bin/agent-insight-entrypoint', ['agent-insight-entrypoint'])


if __name__ == '__main__':
    main()
