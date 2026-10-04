FROM node:22-bookworm-slim
WORKDIR /app
# Copy the reviewed package tarball next to this Dockerfile before building.
COPY uuaid-agent-commons-0.2.0-alpha.1.tgz /app/package.tgz
RUN npm install -g /app/package.tgz && rm /app/package.tgz
USER node
VOLUME ["/home/node/.agent-commons"]
EXPOSE 8787
# Initialize and review admission policy before serving. Global TLS must be
# terminated by an owned reverse proxy; this image does not provide TLS.
ENTRYPOINT ["agent-commons"]
CMD ["doctor"]
