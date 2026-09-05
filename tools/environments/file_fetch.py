"""Remote, descriptor-bound reads for the exec-channel file transport."""

import shlex


# Runs inside the POSIX sandbox, not on the gateway host. No Python modules from
# this checkout are needed remotely. Missing Python/no-follow support fails closed.
_READ_SCRIPT = """
import base64
import os
import stat
import sys
from contextlib import ExitStack

path, limit, marker = sys.argv[1:]
parts = path.split('/')
if not path.startswith('/') or any(p in ('.', '..') for p in parts):
    raise ValueError('expected an absolute canonical path')
parts = [p for p in parts if p]
if not parts:
    raise ValueError('expected a file')
with ExitStack() as stack:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    directory = os.open('/', flags | os.O_DIRECTORY)
    stack.callback(os.close, directory)
    for part in parts[:-1]:
        directory = os.open(part, flags | os.O_DIRECTORY, dir_fd=directory)
        stack.callback(os.close, directory)
    fd = os.open(parts[-1], flags, dir_fd=directory)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('expected a regular file without hard-link aliases')
    with os.fdopen(os.dup(fd), 'rb') as source:
        data = source.read(int(limit) + 1)
print(marker)
print(base64.b64encode(data).decode('ascii'))
print(marker)
"""


def file_fetch_command(path: str, max_bytes: int, marker: str) -> str:
    """Read the resolved pathname without following a swapped leaf or ancestor."""
    return shlex.join(["python3", "-I", "-S", "-c", _READ_SCRIPT, path, str(max_bytes), marker])
