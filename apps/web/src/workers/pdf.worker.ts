import * as Comlink from 'comlink'
import { PdfService } from './pdfService'

Comlink.expose(new PdfService())
