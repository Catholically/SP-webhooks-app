import PDFDocument from 'pdfkit';
import type { CustomsLineItem, OrderCustomsData } from './shopify-customs';

interface CustomsDeclarationData {
  // Company info
  companyName: string;
  vatId: string;
  companyAddress: string;
  companyEmail: string;
  companyPhone: string;

  // Order info
  invoiceNumber: string;
  tracking: string;
  orderDate: string;

  // Receiver info
  receiverName: string;
  receiverAddress: string;
  receiverEmail: string;
  receiverPhone: string;

  // Line items
  lineItems: CustomsLineItem[];
  totalValue: number;

  // Legal representative
  legalRepName: string;
}

/**
 * Generate a customs declaration PDF matching the exact format
 * @param data - Customs declaration data
 * @returns PDF as Buffer
 */
export async function generateCustomsDeclarationPDF(
  data: CustomsDeclarationData
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers: Uint8Array[] = [];

      doc.on('data', (chunk: Uint8Array) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // Page 1: Commercial Invoice + Italian Declaration

      // ========== HEADER SECTION ==========
      doc.fontSize(11).font('Helvetica-Bold');
      doc.text(data.companyName, 40, 40);
      doc.fontSize(9).font('Helvetica');
      doc.text(`VAT ID ${data.vatId}`);
      doc.text(`Partita IVA / CF: ${data.vatId.replace('IT', '')}`);
      doc.text(data.companyAddress);
      doc.text(data.companyEmail);
      doc.text(data.companyPhone);

      // Right side header
      const rightX = 380;
      doc.fontSize(9).font('Helvetica-Bold');
      doc.text(`Invoice No. ${data.invoiceNumber}`, rightX, 40, { width: 175 });
      doc.font('Helvetica');
      doc.text(`Tracking: ${data.tracking}`, rightX);
      doc.text(`Email: ${data.receiverEmail}`, rightX);
      doc.text(`Tel. ${data.receiverPhone}`, rightX);

      // Ship to section
      doc.moveDown(1);
      const shipToY = 120;
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Ship to:', 40, shipToY);
      doc.font('Helvetica');
      doc.fontSize(9);
      doc.text(data.receiverName, 40, shipToY + 15);
      const receiverAddressLines = data.receiverAddress.split('\n');
      let currentY = shipToY + 27;
      for (const line of receiverAddressLines) {
        doc.text(line, 40, currentY);
        currentY += 12;
      }

      // ========== TABLE SECTION ==========
      const tableTop = currentY + 20;
      const col1 = 40;  // Item Description
      const col2 = 280; // Qty
      const col3 = 315; // HS CODE
      const col4 = 380; // Origin
      const col5 = 440; // Price
      const col6 = 500; // Total

      // Table header
      doc.fontSize(9).font('Helvetica-Bold');
      doc.text('Item Description', col1, tableTop);
      doc.text('Qty', col2, tableTop);
      doc.text('HS CODE', col3, tableTop);
      doc.text('Origin', col4, tableTop);
      doc.text('Price', col5, tableTop);
      doc.text('Total', col6, tableTop);

      // Line under header
      doc.moveTo(col1, tableTop + 12).lineTo(555, tableTop + 12).stroke();

      // Table rows
      let rowY = tableTop + 20;
      doc.font('Helvetica');

      for (const item of data.lineItems) {
        // Check if we need a new page
        if (rowY > 350) {
          doc.addPage();
          rowY = 40;
        }

        const description = item.customsDescription || item.title;
        doc.text(description, col1, rowY, { width: 230, lineBreak: false });
        doc.text(`×${item.quantity}`, col2, rowY);
        doc.text(item.hsCode, col3, rowY);
        doc.text(item.origin, col4, rowY);
        doc.text(`$${item.price.toFixed(2)}`, col5, rowY);
        doc.text(`$${(item.price * item.quantity).toFixed(2)}`, col6, rowY);
        rowY += 15;
      }

      // Total row
      rowY += 5;
      doc.moveTo(col1, rowY).lineTo(555, rowY).stroke();
      rowY += 10;
      doc.font('Helvetica-Bold');
      doc.text('TOTAL (USD)', col5, rowY);
      doc.text(`$${data.totalValue.toFixed(2)}`, col6, rowY);
      rowY += 20;

      // Reasons for export
      doc.font('Helvetica');
      doc.text('Reasons for export:', 40, rowY);
      rowY += 12;
      doc.text('Commercial Sale', 40, rowY);
      rowY += 15;

      // Declaration
      doc.fontSize(8);
      doc.text(
        'I declare that the above information is true and correct to the best of my knowledge.',
        40,
        rowY,
        { width: 515 }
      );
      rowY += 30;

      // ========== ITALIAN DECLARATION SECTION ==========
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text(
        'Dichiarazione di libera esportazione – mandato emissione certificati EUR.1 / A.TR.',
        40,
        rowY,
        { width: 515 }
      );
      rowY += 20;

      doc.fontSize(8).font('Helvetica');
      const italianText = `Io sottoscritto ${data.legalRepName} in qualità di legale rappresentante della società ${data.companyName}
Dichiaro sotto la mia personale responsabilità che le merci contenute nella spedizione:
${data.tracking}
Fattura n. ${data.invoiceNumber} del ${data.orderDate}
Customer: ${data.receiverName}

- Non rientrano tra quelle protette dalla Convenzione di Washington (CITES), come da regolamento (CE) n. 338/97 del Consiglio del 9 dicembre 1996 e successive modifiche relativo alla protezione di specie della flora e della fauna selvatiche mediante il controllo del loro commercio.
- Non rientrano nell'elenco dei beni come da regolamento (CE) n. 116/2009 del Consiglio del 18 dicembre 2008 relativo all'esportazione di beni culturali.
- Non rientrano nell'elenco dei beni come da regolamento (UE) n. 821/2021 del Parlamento europeo e del Consiglio del 20 maggio 2021 e successive modifiche che istituisce un regime dell'Unione di controllo delle esportazioni, dell'intermediazione, dell'assistenza tecnica, del transito e del trasferimento di prodotti a duplice uso.
- Non rientrano nell'elenco dei beni come da regolamento (UE) n. 125/2019 del Parlamento europeo e del Consiglio del 16 gennaio 2019 relativo al commercio di determinate merci che potrebbero essere utilizzate per la pena di morte, per la tortura o per altri trattamenti o pene crudeli, inumani o degradanti.
- Non contengono pelliccia di cane e di gatto in conformità al regolamento (CE) n. 1523/2007 del Parlamento europeo e del Consiglio dell'11 dicembre 2007.
- Non sono soggette alle disposizioni del regolamento (UE) n. 649/2012 del Parlamento europeo e del Consiglio del 4 luglio 2012 e successive modifiche sull'esportazione ed importazione di sostanze chimiche pericolose.
- Non sono soggette alla presentazione della licenza di esportazione come da regolamento (CE) n. 1005/2009 del Parlamento europeo e del Consiglio del 16 settembre 2009 e successive modifiche sulle sostanze che riducono lo strato di ozono.
- Non sono soggette alle disposizioni del regolamento (CE) n. 1013/2006 del Parlamento europeo e del Consiglio del 14 giugno 2006 relativo alle spedizioni di rifiuti.
- Non rientrano nell'elenco dei beni come da regolamento (CE) n. 1210/2003 del Consiglio del 7 luglio 2003 e successive modifiche relativo a talune specifiche restrizioni alle relazioni economiche e finanziarie con l'Iraq.
- Non rientrano nell'elenco dei beni come da regolamento (UE) n. 2016/44 del Consiglio del 18 gennaio 2016 concernente misure restrittive in considerazione della situazione in Libia.
- Non rientrano nell'elenco dei beni come da regolamento (CE) n. 765/2006 del Consiglio del 18 maggio 2006 e successive modifiche concernente misure restrittive nei confronti della Bielorussia.
- Non rientrano nell'elenco dei beni come da regolamento (UE) n. 36/2012 del Consiglio del 18 gennaio 2012 e successive modifiche concernente misure restrittive in considerazione della situazione in Siria.
- Non sono soggette alle disposizioni del regolamento (UE) n. 833/2014 del Consiglio del 31 luglio 2014 e successive modifiche concernente misure restrittive in considerazione delle azioni della Russia che destabilizzano la situazione in Ucraina.
- Non sono soggette alle disposizioni della decisione 2014/512/PESC del Consiglio del 31 luglio 2014 concernente misure restrittive in considerazione delle azioni della Russia che destabilizzano la situazione in Ucraina.

Data ${data.orderDate}

Con la presente, inoltre, conferiamo mandato alla società di richiedere alla Dogana di competenza, qualora previsto dagli accordi doganali vigenti, il rilascio del certificato di circolazione delle merci EUR.1 (ovvero EUR-MED) / A.TR. e a sottoscriverlo per nostro conto. Si dichiara che le merci riferite alla presente fattura sono prodotte in Italia e/o nella Comunità e rispondono alle norme di origine preferenziale. Ci si impegna, inoltre, a fornire, in qualsiasi momento, tutte le informazioni e i documenti necessari ai fini del rilascio del certificato richiesto.

Data ${data.orderDate}`;

      doc.text(italianText, 40, rowY, { width: 515, lineGap: 2 });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Create customs declaration PDF from order data
 * @param orderData - Order customs data from Shopify
 * @param tracking - Tracking number
 * @param receiverName - Receiver name
 * @param receiverAddress - Formatted receiver address
 * @returns PDF Buffer
 */
export async function createCustomsDeclarationFromOrder(
  orderData: OrderCustomsData,
  tracking: string,
  receiverName: string,
  receiverAddress: string
): Promise<Buffer> {
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  const data: CustomsDeclarationData = {
    companyName: 'RBK S.r.l.',
    vatId: 'IT16281261004',
    companyAddress: 'Piazzale Clodio 22, Rome, ITALY',
    companyEmail: 'info@catholically.com',
    companyPhone: '(39) 327-925-4096',
    invoiceNumber: orderData.orderNumber,
    tracking: tracking,
    orderDate: dateStr,
    receiverName: receiverName,
    receiverAddress: receiverAddress,
    receiverEmail: orderData.receiverEmail,
    receiverPhone: orderData.receiverPhone,
    lineItems: orderData.lineItems,
    totalValue: orderData.totalValue,
    legalRepName: 'ROBERTA PARMA',
  };

  return generateCustomsDeclarationPDF(data);
}
