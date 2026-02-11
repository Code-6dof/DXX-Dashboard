#!/bin/bash
# Create a distribution package for the gamelog uploader
# This creates a standalone folder that can be shared with players

DIST_DIR="gamelog-uploader-dist"
VERSION="1.0.0"

echo "Creating gamelog uploader distribution package..."

# Clean previous build
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Copy necessary files
cp gamelog-uploader.js "$DIST_DIR/"
cp UPLOADER-README.md "$DIST_DIR/README.md"
cp start-uploader.sh "$DIST_DIR/"
cp start-uploader.bat "$DIST_DIR/"

# Make scripts executable
chmod +x "$DIST_DIR/start-uploader.sh"

# Create a simple package.json for standalone mode
cat > "$DIST_DIR/package.json" << 'EOF'
{
  "name": "dxx-gamelog-uploader",
  "version": "1.0.0",
  "description": "Upload DXX-Redux gamelog to tracking server",
  "main": "gamelog-uploader.js",
  "scripts": {
    "start": "node gamelog-uploader.js"
  },
  "engines": {
    "node": ">=12.0.0"
  }
}
EOF

# Create archive
ARCHIVE_NAME="dxx-gamelog-uploader-v${VERSION}.tar.gz"
tar -czf "$ARCHIVE_NAME" "$DIST_DIR"

echo ""
echo "Distribution package created:"
echo "  Directory: $DIST_DIR/"
echo "  Archive: $ARCHIVE_NAME"
echo ""
echo "Distribution contents:"
ls -lh "$DIST_DIR"
echo ""
echo "To distribute:"
echo "  1. Share the $ARCHIVE_NAME file or the $DIST_DIR/ folder"
echo "  2. Recipients extract and run: node gamelog-uploader.js"
echo "  3. Or use the start scripts: ./start-uploader.sh (Linux/Mac) or start-uploader.bat (Windows)"
