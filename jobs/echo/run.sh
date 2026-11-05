#!/bin/sh
set -eu

if [ -f /input ]; then
  input_file=/input
elif [ -f /input/job.json ]; then
  input_file=/input/job.json
else
  echo "expected /input or /input/job.json" >&2
  exit 1
fi

if [ ! -d /output ]; then
  echo "expected writable /output directory" >&2
  exit 1
fi

cat "$input_file" > /output/tile-0
