FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        bubblewrap \
        ca-certificates \
        curl \
        file \
        git \
        netcat-openbsd \
        openssh-client \
        python3 \
        python3-gmpy2 \
        python3-pip \
        python3-pycryptodome \
        python3-sympy \
        xz-utils \
    && python3 -m pip install --break-system-packages --no-cache-dir pycryptodome \
    && npm install -g @openai/codex \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/mecha-runner-entrypoint
RUN chmod 0755 /usr/local/bin/mecha-runner-entrypoint

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/mecha-runner-entrypoint"]
CMD ["sleep", "infinity"]
