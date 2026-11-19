FROM node:24-alpine
# Add languages by name, e.g. --build-arg OCR_LANGS="eng fra deu spa ita por nld"
ARG OCR_LANGS="eng fra deu spa ita por nld"
RUN apk add --no-cache tesseract-ocr $(for l in $OCR_LANGS; do printf 'tesseract-ocr-data-%s ' "$l"; done)
WORKDIR /app
COPY server.js .
USER node
ENV OCR_LANGS=eng+fra
EXPOSE 8884
CMD ["node", "server.js"]
