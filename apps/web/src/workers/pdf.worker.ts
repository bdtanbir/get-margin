import * as Comlink from 'comlink'
import { PdfService } from './pdfService'
import './transferHandlers'

Comlink.expose(new PdfService())
