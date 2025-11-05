import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
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
  // Create a new PDF document
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([595, 842]); // A4 size in points
  const { width, height } = page.getSize();

  // Embed fonts
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Download and embed signature image once
  let signatureImage = null;
  try {
    const signatureUrl = 'https://cdn.shopify.com/s/files/1/0044/7722/3030/files/Firma_e_Timbro_RBK.png';
    console.log('[PDF] Downloading signature image from:', signatureUrl);
    const signatureResponse = await fetch(signatureUrl);
    if (signatureResponse.ok) {
      const signatureArrayBuffer = await signatureResponse.arrayBuffer();
      signatureImage = await pdfDoc.embedPng(signatureArrayBuffer);
      console.log('[PDF] ✅ Signature image embedded');
    } else {
      console.warn('[PDF] ⚠️ Failed to download signature image:', signatureResponse.status);
    }
  } catch (error) {
    console.error('[PDF] ❌ Error downloading signature image:', error);
  }

  const margin = 40;
  let y = height - margin - 20;

  // Helper function to draw signature at a position
  const drawSignature = (currentPage: any, atY: number, signatureWidth = 150): number => {
    if (!signatureImage) return 0;

    const signatureAspectRatio = signatureImage.width / signatureImage.height;
    const signatureHeight = signatureWidth / signatureAspectRatio;

    currentPage.drawImage(signatureImage, {
      x: width - margin - signatureWidth, // Right aligned
      y: atY - signatureHeight,
      width: signatureWidth,
      height: signatureHeight,
    });

    return signatureHeight;
  };

  // ========== HEADER SECTION ==========
  // Company info (left side)
  page.drawText(data.companyName, {
    x: margin,
    y: y,
    size: 11,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  y -= 14;

  const companyLines = [
    `VAT ID ${data.vatId}`,
    `Partita IVA / CF: ${data.vatId.replace('IT', '')}`,
    data.companyAddress,
    data.companyEmail,
    data.companyPhone,
  ];

  for (const line of companyLines) {
    page.drawText(line, {
      x: margin,
      y: y,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    y -= 12;
  }

  // Invoice info (right side)
  const rightX = 380;
  let rightY = height - margin - 20;

  page.drawText(`Invoice No. ${data.invoiceNumber}`, {
    x: rightX,
    y: rightY,
    size: 9,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  rightY -= 12;

  const rightLines = [
    `Tracking: ${data.tracking}`,
    `Email: ${data.receiverEmail}`,
    `Tel. ${data.receiverPhone}`,
  ];

  for (const line of rightLines) {
    page.drawText(line, {
      x: rightX,
      y: rightY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    rightY -= 12;
  }

  // Ship to section
  y = height - 200;
  page.drawText('Ship to:', {
    x: margin,
    y: y,
    size: 10,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  y -= 15;

  page.drawText(data.receiverName, {
    x: margin,
    y: y,
    size: 9,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  y -= 12;

  const addressLines = data.receiverAddress.split('\n');
  for (const line of addressLines) {
    page.drawText(line, {
      x: margin,
      y: y,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    y -= 12;
  }

  // ========== TABLE SECTION ==========
  y -= 20;
  const tableTop = y;
  const col1 = 40;  // Item Description
  const col2 = 280; // Qty
  const col3 = 315; // HS CODE
  const col4 = 380; // Origin
  const col5 = 440; // Price
  const col6 = 500; // Total

  // Table header
  const headers = [
    { text: 'Item Description', x: col1 },
    { text: 'Qty', x: col2 },
    { text: 'HS CODE', x: col3 },
    { text: 'Origin', x: col4 },
    { text: 'Price', x: col5 },
    { text: 'Total', x: col6 },
  ];

  for (const header of headers) {
    page.drawText(header.text, {
      x: header.x,
      y: tableTop,
      size: 9,
      font: fontBold,
      color: rgb(0, 0, 0),
    });
  }

  // Line under header
  page.drawLine({
    start: { x: col1, y: tableTop - 12 },
    end: { x: 555, y: tableTop - 12 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });

  // Table rows
  let rowY = tableTop - 20;

  for (const item of data.lineItems) {
    // Check if we need a new page
    if (rowY < 200) {
      page = pdfDoc.addPage([595, 842]);
      rowY = height - margin;
    }

    const description = item.customsDescription || item.title;
    // Truncate description if too long
    const maxDescLength = 35;
    const truncatedDesc = description.length > maxDescLength
      ? description.substring(0, maxDescLength) + '...'
      : description;

    page.drawText(truncatedDesc, {
      x: col1,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    page.drawText(`×${item.quantity}`, {
      x: col2,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    page.drawText(item.hsCode, {
      x: col3,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    page.drawText(item.origin, {
      x: col4,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    page.drawText(`$${item.price.toFixed(2)}`, {
      x: col5,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    page.drawText(`$${(item.price * item.quantity).toFixed(2)}`, {
      x: col6,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
    rowY -= 15;
  }

  // Total row
  rowY -= 5;
  page.drawLine({
    start: { x: col1, y: rowY },
    end: { x: 555, y: rowY },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  rowY -= 10;

  page.drawText('TOTAL (USD)', {
    x: col5,
    y: rowY,
    size: 9,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  page.drawText(`$${data.totalValue.toFixed(2)}`, {
    x: col6,
    y: rowY,
    size: 9,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  rowY -= 20;

  // Reasons for export
  page.drawText('Reasons for export:', {
    x: margin,
    y: rowY,
    size: 9,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  rowY -= 12;
  page.drawText('Commercial Sale', {
    x: margin,
    y: rowY,
    size: 9,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  rowY -= 15;

  // Declaration
  const declarationText = 'I declare that the above information is true and correct to the best of my knowledge.';
  page.drawText(declarationText, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
    maxWidth: 350, // Reduced width to make room for signature
  });

  // Add signature #1 - After English declaration, aligned right
  const sig1Height = drawSignature(page, rowY, 150);
  rowY -= Math.max(30, sig1Height + 10);

  // ========== ITALIAN DECLARATION SECTION ==========
  page.drawText(
    'Dichiarazione di libera esportazione - mandato emissione certificati EUR.1 / A.TR.',
    {
      x: margin,
      y: rowY,
      size: 10,
      font: fontBold,
      color: rgb(0, 0, 0),
      maxWidth: 515,
    }
  );
  rowY -= 20;

  // First two lines of Italian declaration
  page.drawText(`Io sottoscritto ${data.legalRepName} in qualita di legale rappresentante della societa ${data.companyName}`, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  rowY -= 10;

  page.drawText(`Dichiaro sotto la mia personale responsabilita che le merci contenute nella spedizione:`, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  rowY -= 10;

  // Tracking number - BOLD
  page.drawText(data.tracking, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  rowY -= 10;

  // Invoice line - "Fattura n." normal, invoice number BOLD, "del date" normal
  let currentX = margin;
  page.drawText('Fattura n. ', {
    x: currentX,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  currentX += fontRegular.widthOfTextAtSize('Fattura n. ', 8);

  page.drawText(data.invoiceNumber, {
    x: currentX,
    y: rowY,
    size: 8,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  currentX += fontBold.widthOfTextAtSize(data.invoiceNumber, 8);

  page.drawText(` del ${data.orderDate}`, {
    x: currentX,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  rowY -= 10;

  // Customer line - "Customer:" normal, name BOLD
  currentX = margin;
  page.drawText('Customer: ', {
    x: currentX,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  currentX += fontRegular.widthOfTextAtSize('Customer: ', 8);

  page.drawText(data.receiverName, {
    x: currentX,
    y: rowY,
    size: 8,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  rowY -= 10;

  // Empty line
  rowY -= 10;

  // Italian declaration paragraphs with proper word wrap
  const declarationParagraphs = [
    '- Non rientrano tra quelle protette dalla Convenzione di Washington (CITES), come da regolamento (CE) n. 338/97 del Consiglio del 9 dicembre 1996 e successive modifiche.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (CE) n. 116/2009 del Consiglio del 18 dicembre 2008 relativo all\'esportazione di beni culturali.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (UE) n. 821/2021 del Parlamento europeo e del Consiglio del 20 maggio 2021 che istituisce un regime dell\'Unione di controllo delle esportazioni, dell\'intermediazione, dell\'assistenza tecnica, del transito e del trasferimento di prodotti a duplice uso.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (UE) n. 125/2019 del Parlamento europeo e del Consiglio del 16 gennaio 2019 relativo al commercio di determinate merci che potrebbero essere utilizzate per la pena di morte, per la tortura o per altri trattamenti o pene crudeli, inumani o degradanti.',
    '- Non contengono pelliccia di cane e di gatto in conformita al regolamento (CE) n. 1523/2007 del Parlamento europeo e del Consiglio dell\'11 dicembre 2007.',
    '- Non sono soggette alle disposizioni del regolamento (UE) n. 649/2012 del Parlamento europeo e del Consiglio del 4 luglio 2012 sull\'esportazione ed importazione di sostanze chimiche pericolose.',
    '- Non sono soggette alla presentazione della licenza di esportazione come da regolamento (CE) n. 1005/2009 del Parlamento europeo e del Consiglio del 16 settembre 2009 sulle sostanze che riducono lo strato di ozono.',
    '- Non sono soggette alle disposizioni del regolamento (CE) n. 1013/2006 del Parlamento europeo e del Consiglio del 14 giugno 2006 relativo alle spedizioni di rifiuti.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (CE) n. 1210/2003 del Consiglio del 7 luglio 2003 relativo a talune specifiche restrizioni alle relazioni economiche e finanziarie con l\'Iraq.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (UE) n. 2016/44 del Consiglio del 18 gennaio 2016 concernente misure restrittive in considerazione della situazione in Libia.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (CE) n. 765/2006 del Consiglio del 18 maggio 2006 concernente misure restrittive nei confronti della Bielorussia.',
    '- Non rientrano nell\'elenco dei beni come da regolamento (UE) n. 36/2012 del Consiglio del 18 gennaio 2012 concernente misure restrittive in considerazione della situazione in Siria.',
    '- Non sono soggette alle disposizioni del regolamento (UE) n. 833/2014 del Consiglio del 31 luglio 2014 concernente misure restrittive in considerazione delle azioni della Russia che destabilizzano la situazione in Ucraina.',
    '- Non sono soggette alle disposizioni della decisione 2014/512/PESC del Consiglio del 31 luglio 2014 concernente misure restrittive in considerazione delle azioni della Russia che destabilizzano la situazione in Ucraina.',
  ];

  // Draw declaration paragraphs with word wrap
  for (const paragraph of declarationParagraphs) {
    if (rowY < 60) {
      page = pdfDoc.addPage([595, 842]);
      rowY = height - margin;
    }

    const textHeight = fontRegular.heightAtSize(8);
    const lines = page.drawText(paragraph, {
      x: margin,
      y: rowY,
      size: 8,
      font: fontRegular,
      color: rgb(0, 0, 0),
      maxWidth: 515,
      lineHeight: 10,
    });

    // Estimate number of lines (rough calculation)
    const estimatedLines = Math.ceil(fontRegular.widthOfTextAtSize(paragraph, 8) / 515);
    rowY -= (estimatedLines * 10) + 3; // Add small spacing between paragraphs
  }

  rowY -= 10;

  // First "Data" line
  page.drawText(`Data ${data.orderDate}`, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });

  // Signature #2 after first "Data"
  drawSignature(page, rowY, 150);
  rowY -= 20;

  // Final paragraph
  const finalParagraph = 'Con la presente, inoltre, conferiamo mandato alla societa di richiedere alla Dogana di competenza, qualora previsto dagli accordi doganali vigenti, il rilascio del certificato di circolazione delle merci EUR.1 (ovvero EUR-MED) / A.TR. e a sottoscriverlo per nostro conto. Si dichiara che le merci riferite alla presente fattura sono prodotte in Italia e/o nella Comunita e rispondono alle norme di origine preferenziale. Ci si impegna, inoltre, a fornire, in qualsiasi momento, tutte le informazioni e i documenti necessari ai fini del rilascio del certificato richiesto.';

  if (rowY < 80) {
    page = pdfDoc.addPage([595, 842]);
    rowY = height - margin;
  }

  page.drawText(finalParagraph, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
    maxWidth: 515,
    lineHeight: 10,
  });

  const finalEstimatedLines = Math.ceil(fontRegular.widthOfTextAtSize(finalParagraph, 8) / 515);
  rowY -= (finalEstimatedLines * 10) + 10;

  // Second "Data" line
  page.drawText(`Data ${data.orderDate}`, {
    x: margin,
    y: rowY,
    size: 8,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });

  // Signature #3 after second "Data"
  drawSignature(page, rowY, 150);

  // Serialize the PDF to bytes
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
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
