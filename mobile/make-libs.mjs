// The libraries create_file uses on the phones (make.js), bundled by mobile/build.mjs into www/vendor/make-libs.js and loaded
// with the first file. The prebuilt browser builds, not the packages' Node entry points (pdfkit, streams, zlib).
import pdfmake from 'pdfmake/build/pdfmake.js';
import vfs from 'pdfmake/build/vfs_fonts.js';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { marked } from 'marked';

pdfmake.addVirtualFileSystem(vfs); // Roboto, as on the desktop
pdfmake.setUrlAccessPolicy(() => false); // a PDF never fetches anything

export default { pdfmake, PptxGenJS, JSZip, marked };
