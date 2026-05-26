const WOLFHOUSE_CONFIG = {
  spreadsheetId: '1eISph-eVZpylAEFVRS22hxRvWydBj07vz6G-vO7T_cc',

  planningSheetName: 'Planning',
  manualEntriesSheetName: 'Manual Entries',

  manualEntriesQueueWebhookUrl: 'https://tywoods.app.n8n.cloud/webhook/wolfhouse-manual-entries-queue',

  bedIdColumn: 1,
  dateHeaderRow: 4,
  firstDateColumn: 3,
  firstBedRow: 5,

  colors: {
    manualPending: '#fce5cd',
    hold: '#fff2cc',
    confirmed: '#d9ead3',
    paid: '#b6d7a8',
    blocked: '#cfe2f3',
    needsReview: '#eadcf8',
    conflict: '#f4cccc',
    cancelled: '#d9d9d9',
    text: '#000000',
    white: '#ffffff',
    border: '#000000'
  },

  manualHeaders: [
    'Manual Entry ID',
    'Created At',
    'Created By',
    'Guest Name',
    'Package',
    'Deposit Paid',
    'Phone',
    'Email',
    'Check In',
    'Check Out',
    'Guest Count',
    'Room / Bed',
    'Status',
    'Payment Status',
    'Notes',
    'Sync Status',
    'Airtable Booking ID',
    'Error'
  ]
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Wolfhouse')
    .addItem('Create Manual Booking From Selection', 'showManualBookingDialog')
    .addItem('Update Manual Booking From Selection', 'showUpdateManualBookingDialog')
    .addItem('Delete Highlighted Manual Booking', 'deleteManualBookingFromSelection')
    .addSeparator()
    .addItem('Sync Manual Entries Now', 'syncManualEntriesNow')
    .addItem('Clear Planning Booking Paint', 'clearPlanningBookingPaint')
    .addItem('Setup Manual Entries Headers', 'setupManualEntriesHeaders')
    .addToUi();
}

function getWolfhouseSpreadsheet_() {
  return SpreadsheetApp.openById(WOLFHOUSE_CONFIG.spreadsheetId);
}

function setupManualEntriesHeaders() {
  const ss = getWolfhouseSpreadsheet_();
  const sheet = getOrCreateManualEntriesSheet_(ss);

  ensureManualHeaders_(sheet);
  sheet.autoResizeColumns(1, WOLFHOUSE_CONFIG.manualHeaders.length);

  SpreadsheetApp.getUi().alert('Manual Entries headers are ready.');
}

function syncManualEntriesNow() {
  const result = triggerManualEntriesQueueWebhook_({
    action: 'manual_sync_button',
    manualEntryId: '',
    rowNumber: '',
    syncStatus: '',
    source: 'google_sheets_menu'
  });

  if (result.ok) {
    SpreadsheetApp.getUi().alert('Manual Entries sync triggered.');
  } else {
    SpreadsheetApp.getUi().alert(`Manual Entries sync trigger failed:\n\n${result.error}`);
  }
}

function clearPlanningBookingPaint() {
  const ui = SpreadsheetApp.getUi();
  const ss = getWolfhouseSpreadsheet_();
  const planningSheet = ss.getSheetByName(WOLFHOUSE_CONFIG.planningSheetName);

  if (!planningSheet) {
    ui.alert(`Could not find the "${WOLFHOUSE_CONFIG.planningSheetName}" sheet.`);
    return;
  }

  const response = ui.alert(
    'Clear Planning booking paint?',
    'This will clear booking text, notes, fill colors, and booking borders from the Planning grid only.\n\nIt will not delete dates, room labels, Manual Entries, or Airtable records.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    return;
  }

  const lastRow = planningSheet.getMaxRows();
  const lastCol = planningSheet.getMaxColumns();

  const startRow = WOLFHOUSE_CONFIG.firstBedRow;
  const startCol = WOLFHOUSE_CONFIG.firstDateColumn;

  const numRows = lastRow - startRow + 1;
  const numCols = lastCol - startCol + 1;

  if (numRows <= 0 || numCols <= 0) {
    ui.alert('No Planning booking grid found to clear.');
    return;
  }

  const range = planningSheet.getRange(startRow, startCol, numRows, numCols);

  range
    .clearContent()
    .clearNote()
    .setBackground(WOLFHOUSE_CONFIG.colors.white)
    .setFontColor(WOLFHOUSE_CONFIG.colors.text)
    .setFontWeight('normal')
    .setWrap(true)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBorder(false, false, false, false, false, false);

  SpreadsheetApp.flush();

  ui.alert(`Planning booking paint cleared from ${range.getA1Notation()}.`);
}

function showManualBookingDialog() {
  const context = getSelectionContext_();

  if (!context.ok) {
    SpreadsheetApp.getUi().alert(context.error);
    return;
  }

  const template = HtmlService.createTemplateFromFile('ManualBookingDialog');
  template.contextJson = JSON.stringify(context);

  const html = template.evaluate()
    .setWidth(470)
    .setHeight(760);

  SpreadsheetApp.getUi().showModalDialog(html, 'Create Manual Booking');
}

function showUpdateManualBookingDialog() {
  const ui = SpreadsheetApp.getUi();
  const ss = getWolfhouseSpreadsheet_();
  const planningSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (!planningSheet || planningSheet.getName() !== WOLFHOUSE_CONFIG.planningSheetName) {
    ui.alert(`Go to the "${WOLFHOUSE_CONFIG.planningSheetName}" tab and select a cell inside the manual booking first.`);
    return;
  }

  const selectedRange = planningSheet.getActiveRange();

  if (!selectedRange) {
    ui.alert('Select a cell inside the manual booking first.');
    return;
  }

  const manualEntryIds = findManualEntryIdsInRange_(selectedRange);

  if (!manualEntryIds.length) {
    ui.alert('No Manual Entry ID found in the selected cell/range. Select a cell inside a manual booking block.');
    return;
  }

  if (manualEntryIds.length > 1) {
    ui.alert(`Your selection includes multiple manual bookings: ${manualEntryIds.join(', ')}. Select only one manual booking block.`);
    return;
  }

  const manualEntryId = manualEntryIds[0];
  const rowLookup = findManualEntryRow_(ss, manualEntryId);

  if (!rowLookup.found) {
    ui.alert(`Found ${manualEntryId} on the calendar, but could not find the matching row in Manual Entries.`);
    return;
  }

  const template = HtmlService.createTemplateFromFile('UpdateManualBookingDialog');
  template.dataJson = JSON.stringify({
    manualEntryId,
    row: rowLookup.rowObject
  });

  const html = template.evaluate()
    .setWidth(470)
    .setHeight(760);

  SpreadsheetApp.getUi().showModalDialog(html, 'Update Manual Booking');
}

function submitManualBooking(formData) {
  const ss = getWolfhouseSpreadsheet_();
  const planningSheet = ss.getSheetByName(WOLFHOUSE_CONFIG.planningSheetName);
  const manualSheet = getOrCreateManualEntriesSheet_(ss);

  ensureManualHeaders_(manualSheet);

  const context = formData && formData.context ? formData.context : null;
  validateContextObject_(context);

  if (!planningSheet) {
    throw new Error(`Could not find the "${WOLFHOUSE_CONFIG.planningSheetName}" sheet.`);
  }

  const guestName = String(formData.guestName || '').trim();
  const guestCount = Number(formData.guestCount || context.defaultGuestCount || 1);

  if (!guestName) {
    throw new Error('Guest name is required.');
  }

  if (!guestCount || guestCount < 1) {
    throw new Error('Guest count must be at least 1.');
  }

  const manualEntryId = makeManualEntryId_();
  const createdAt = new Date();
  const createdBy = Session.getActiveUser().getEmail() || '';

  const packageName = normalizePackageName_(formData.packageName);
  const depositPaid = String(formData.depositPaid || '').trim();
  const status = String(formData.status || 'Confirmed').trim();
  const paymentStatus = String(formData.paymentStatus || 'waiting_payment').trim();
  const phone = String(formData.phone || '').trim();
  const email = String(formData.email || '').trim();
  const notes = String(formData.notes || '').trim();

  const rowObject = {
    'Manual Entry ID': manualEntryId,
    'Created At': createdAt,
    'Created By': createdBy,
    'Guest Name': guestName,
    'Package': packageName,
    'Deposit Paid': depositPaid,
    'Phone': phone,
    'Email': email,
    'Check In': context.checkIn,
    'Check Out': context.checkOut,
    'Guest Count': guestCount,
    'Room / Bed': context.bedIds.join(', '),
    'Status': status,
    'Payment Status': paymentStatus,
    'Notes': notes,
    'Sync Status': 'Ready',
    'Airtable Booking ID': '',
    'Error': ''
  };

  const appendedRowNumber = appendManualEntry_(manualSheet, rowObject);
  SpreadsheetApp.flush();

  const verifyValue = String(manualSheet.getRange(appendedRowNumber, 1).getValue() || '').trim();

  if (verifyValue !== manualEntryId) {
    throw new Error(
      `Manual Entries write failed. Expected ${manualEntryId} in row ${appendedRowNumber}, but found "${verifyValue}".`
    );
  }

  paintManualBookingCells_({
    planningSheet,
    context,
    manualEntryId,
    guestName,
    guestCount,
    packageName,
    depositPaid,
    status,
    paymentStatus,
    notes
  });

  SpreadsheetApp.flush();

  const webhookResult = triggerManualEntriesQueueWebhook_({
    action: 'create',
    manualEntryId,
    rowNumber: appendedRowNumber,
    syncStatus: 'Ready',
    source: 'google_sheets_create'
  });

  return {
    ok: true,
    manualEntryId,
    appendedRowNumber,
    webhookTriggered: webhookResult.ok,
    webhookError: webhookResult.error || '',
    message: webhookResult.ok
      ? `Manual booking queued and sync triggered: ${guestName} · ${context.checkIn} to ${context.checkOut} · ${context.bedIds.join(', ')} · Manual Entries row ${appendedRowNumber}`
      : `Manual booking queued, but sync trigger failed. Use Wolfhouse → Sync Manual Entries Now. Error: ${webhookResult.error}`
  };
}

function submitUpdateManualBooking(formData) {
  const ss = getWolfhouseSpreadsheet_();
  const planningSheet = ss.getSheetByName(WOLFHOUSE_CONFIG.planningSheetName);

  if (!planningSheet) {
    throw new Error(`Could not find the "${WOLFHOUSE_CONFIG.planningSheetName}" sheet.`);
  }

  const manualEntryId = String(formData.manualEntryId || '').trim();

  if (!manualEntryId) {
    throw new Error('Missing Manual Entry ID.');
  }

  const rowLookup = findManualEntryRow_(ss, manualEntryId);

  if (!rowLookup.found) {
    throw new Error(`Could not find ${manualEntryId} in Manual Entries.`);
  }

  const existing = rowLookup.rowObject;
  const previousSyncStatus = String(existing['Sync Status'] || '').trim();
  const airtableBookingId = String(existing['Airtable Booking ID'] || '').trim();

  const guestName = String(formData.guestName || '').trim();

  if (!guestName) {
    throw new Error('Guest name is required.');
  }

  const guestCount = Number(formData.guestCount || existing['Guest Count'] || 1);

  if (!guestCount || guestCount < 1) {
    throw new Error('Guest count must be at least 1.');
  }

  let nextSyncStatus = 'Ready';

  if (previousSyncStatus === 'Synced' && airtableBookingId) {
    nextSyncStatus = 'Update Ready';
  }

  if (previousSyncStatus === 'Processing' || previousSyncStatus === 'Update Processing' || previousSyncStatus === 'Delete Processing') {
    nextSyncStatus = previousSyncStatus;
  }

  if (previousSyncStatus === 'Delete Ready' || previousSyncStatus === 'Deleted') {
    throw new Error(`This manual booking is already marked ${previousSyncStatus} and cannot be updated.`);
  }

  const updatedRow = {
    ...existing,
    'Guest Name': guestName,
    'Package': normalizePackageName_(formData.packageName),
    'Deposit Paid': String(formData.depositPaid || '').trim(),
    'Phone': String(formData.phone || '').trim(),
    'Email': String(formData.email || '').trim(),
    'Guest Count': guestCount,
    'Status': String(formData.status || 'Confirmed').trim(),
    'Payment Status': String(formData.paymentStatus || 'waiting_payment').trim(),
    'Notes': String(formData.notes || '').trim(),
    'Sync Status': nextSyncStatus,
    'Airtable Booking ID': airtableBookingId,
    'Error': ''
  };

  updateManualEntryRow_(rowLookup.sheet, rowLookup.rowNumber, updatedRow);
  repaintManualBookingById_(planningSheet, updatedRow);

  SpreadsheetApp.flush();

  let webhookResult = { ok: true, error: '' };

  if (nextSyncStatus === 'Ready' || nextSyncStatus === 'Update Ready') {
    webhookResult = triggerManualEntriesQueueWebhook_({
      action: nextSyncStatus === 'Update Ready' ? 'update' : 'create',
      manualEntryId,
      rowNumber: rowLookup.rowNumber,
      syncStatus: nextSyncStatus,
      source: 'google_sheets_update'
    });
  }

  return {
    ok: true,
    manualEntryId,
    webhookTriggered: webhookResult.ok,
    webhookError: webhookResult.error || '',
    message: webhookResult.ok
      ? `Manual booking updated: ${guestName}. Sync Status: ${nextSyncStatus}`
      : `Manual booking updated, but sync trigger failed. Use Wolfhouse → Sync Manual Entries Now. Error: ${webhookResult.error}`
  };
}

function deleteManualBookingFromSelection() {
  const ui = SpreadsheetApp.getUi();
  const ss = getWolfhouseSpreadsheet_();
  const planningSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (!planningSheet || planningSheet.getName() !== WOLFHOUSE_CONFIG.planningSheetName) {
    ui.alert(`Go to the "${WOLFHOUSE_CONFIG.planningSheetName}" tab and highlight the manual booking block first.`);
    return;
  }

  const selectedRange = planningSheet.getActiveRange();

  if (!selectedRange) {
    ui.alert('Highlight the manual booking block first.');
    return;
  }

  const manualEntryIds = findManualEntryIdsInRange_(selectedRange);

  if (!manualEntryIds.length) {
    ui.alert('No Manual Entry ID found in the highlighted cells. Highlight the manual booking block first.');
    return;
  }

  if (manualEntryIds.length > 1) {
    ui.alert(`The highlighted range includes multiple manual bookings: ${manualEntryIds.join(', ')}. Highlight only one manual booking.`);
    return;
  }

  const manualEntryId = manualEntryIds[0];
  const rowLookup = findManualEntryRow_(ss, manualEntryId);

  if (!rowLookup.found) {
    ui.alert(`Found ${manualEntryId} on the calendar, but could not find the matching row in Manual Entries.`);
    return;
  }

  const existing = rowLookup.rowObject;
  const syncStatus = String(existing['Sync Status'] || '').trim();
  const airtableBookingId = String(existing['Airtable Booking ID'] || '').trim();

  let deleteMessage = `This will clear the highlighted cells and delete ${manualEntryId} from Manual Entries.`;

  if (syncStatus === 'Synced' && airtableBookingId) {
    deleteMessage =
      `This will clear the highlighted cells and mark ${manualEntryId} as Delete Ready.\n\n` +
      `n8n will then delete the Airtable Booking Beds and mark the Airtable Booking as Cancelled.`;
  }

  const response = ui.alert(
    'Delete highlighted manual booking?',
    `${deleteMessage}\n\nContinue?`,
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) {
    return;
  }

  const clearedCells = clearHighlightedRangeFast_(selectedRange);

  let resultMessage = '';
  let webhookResult = { ok: true, error: '' };

  if (syncStatus === 'Synced' && airtableBookingId) {
    const updatedRow = {
      ...existing,
      'Status': 'Cancelled',
      'Sync Status': 'Delete Ready',
      'Airtable Booking ID': airtableBookingId,
      'Error': ''
    };

    updateManualEntryRow_(rowLookup.sheet, rowLookup.rowNumber, updatedRow);
    SpreadsheetApp.flush();

    webhookResult = triggerManualEntriesQueueWebhook_({
      action: 'delete',
      manualEntryId,
      rowNumber: rowLookup.rowNumber,
      syncStatus: 'Delete Ready',
      source: 'google_sheets_delete'
    });

    resultMessage =
      `Manual Entry ID: ${manualEntryId}\n` +
      `Highlighted cells cleared: ${clearedCells}\n` +
      `Manual Entries row kept and marked: Delete Ready\n` +
      `Airtable Booking ID: ${airtableBookingId}\n` +
      `Sync trigger: ${webhookResult.ok ? 'sent' : 'failed'}`;

    if (!webhookResult.ok) {
      resultMessage += `\n\nUse Wolfhouse → Sync Manual Entries Now.\n\nError: ${webhookResult.error}`;
    }
  } else {
    const deletedManualRows = deleteManualEntryRowsFast_(ss, manualEntryId);

    resultMessage =
      `Manual Entry ID: ${manualEntryId}\n` +
      `Highlighted cells cleared: ${clearedCells}\n` +
      `Manual Entries rows deleted: ${deletedManualRows}`;
  }

  SpreadsheetApp.flush();

  ui.alert('Manual booking delete queued', resultMessage, ui.ButtonSet.OK);
}

function triggerManualEntriesQueueWebhook_(data) {
  const url = String(WOLFHOUSE_CONFIG.manualEntriesQueueWebhookUrl || '').trim();

  if (!url) {
    return {
      ok: false,
      error: 'Missing manualEntriesQueueWebhookUrl in WOLFHOUSE_CONFIG.'
    };
  }

  try {
    const payload = {
      action: data.action || 'process_queue',
      source: data.source || 'google_sheets',
      spreadsheetId: WOLFHOUSE_CONFIG.spreadsheetId,
      manualEntryId: data.manualEntryId || '',
      rowNumber: data.rowNumber || '',
      syncStatus: data.syncStatus || '',
      timestamp: new Date().toISOString()
    };

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const statusCode = response.getResponseCode();
    const body = response.getContentText();

    if (statusCode < 200 || statusCode >= 300) {
      return {
        ok: false,
        statusCode,
        error: `Webhook returned HTTP ${statusCode}: ${body}`
      };
    }

    return {
      ok: true,
      statusCode,
      body
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function clearHighlightedRangeFast_(range) {
  const cellCount = range.getNumRows() * range.getNumColumns();

  range
    .clearContent()
    .clearNote()
    .setBackground(WOLFHOUSE_CONFIG.colors.white)
    .setFontColor(WOLFHOUSE_CONFIG.colors.text)
    .setFontWeight('normal')
    .setBorder(false, false, false, false, false, false);

  return cellCount;
}

function deleteManualEntryRowsFast_(ss, manualEntryId) {
  const manualSheet = ss.getSheetByName(WOLFHOUSE_CONFIG.manualEntriesSheetName);

  if (!manualSheet) {
    return 0;
  }

  const lastRow = manualSheet.getLastRow();
  const lastCol = manualSheet.getLastColumn();

  if (lastRow < 2 || lastCol < 1) {
    return 0;
  }

  const headers = manualSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idColIndex = headers.findIndex(header => String(header || '').trim() === 'Manual Entry ID') + 1;

  if (!idColIndex) {
    return 0;
  }

  const idRange = manualSheet.getRange(2, idColIndex, lastRow - 1, 1);
  const matches = idRange
    .createTextFinder(manualEntryId)
    .matchEntireCell(true)
    .findAll();

  if (!matches.length) {
    return 0;
  }

  const rowsToDelete = matches
    .map(cell => cell.getRow())
    .sort((a, b) => b - a);

  rowsToDelete.forEach(row => {
    manualSheet.deleteRow(row);
  });

  return rowsToDelete.length;
}

function getSelectionContext_() {
  const activeSs = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = activeSs.getActiveSheet();

  if (!sheet || sheet.getName() !== WOLFHOUSE_CONFIG.planningSheetName) {
    return {
      ok: false,
      error: `Go to the "${WOLFHOUSE_CONFIG.planningSheetName}" tab, select the booking cells, then try again.`
    };
  }

  const range = sheet.getActiveRange();

  if (!range) {
    return {
      ok: false,
      error: 'Select the bed/date cells for the booking first.'
    };
  }

  const startRow = range.getRow();
  const endRow = range.getLastRow();
  const startCol = range.getColumn();
  const endCol = range.getLastColumn();

  if (startRow < WOLFHOUSE_CONFIG.firstBedRow) {
    return {
      ok: false,
      error: `Select bed rows starting from row ${WOLFHOUSE_CONFIG.firstBedRow} or below.`
    };
  }

  if (startCol < WOLFHOUSE_CONFIG.firstDateColumn) {
    return {
      ok: false,
      error: 'Select date cells starting from column C or later. Do not include the Bed ID column.'
    };
  }

  const bedIds = [];
  const invalidRows = [];

  for (let row = startRow; row <= endRow; row++) {
    const bedId = String(sheet.getRange(row, WOLFHOUSE_CONFIG.bedIdColumn).getValue() || '').trim();

    if (bedId && /^R\d+-B\d+$/i.test(bedId)) {
      bedIds.push(bedId.toUpperCase());
    } else {
      invalidRows.push(row);
    }
  }

  if (invalidRows.length) {
    return {
      ok: false,
      error: `Your selection includes divider/blank rows: ${invalidRows.join(', ')}. Select only actual bed rows like R4-B1, R4-B2, etc.`
    };
  }

  if (!bedIds.length) {
    return {
      ok: false,
      error: 'No valid bed IDs found in the selected rows. Make sure column A has values like R5-B1.'
    };
  }

  const checkInRaw = sheet.getRange(WOLFHOUSE_CONFIG.dateHeaderRow, startCol).getValue();
  const lastNightRaw = sheet.getRange(WOLFHOUSE_CONFIG.dateHeaderRow, endCol).getValue();

  const checkIn = normalizeSheetDate_(checkInRaw);
  const lastNight = normalizeSheetDate_(lastNightRaw);

  if (!checkIn || !lastNight) {
    return {
      ok: false,
      error: 'Could not read the dates from row 4. Make sure the selected columns have real dates in row 4.'
    };
  }

  const checkOut = addDaysIso_(lastNight, 1);

  return {
    ok: true,
    sheetName: sheet.getName(),
    selectionA1: range.getA1Notation(),
    checkIn,
    checkOut,
    lastNight,
    bedIds,
    bedCount: bedIds.length,
    nightCount: daysBetweenIso_(checkIn, checkOut),
    defaultGuestCount: bedIds.length,
    startRow,
    endRow,
    startCol,
    endCol
  };
}

function validateContextObject_(context) {
  if (!context || !context.ok) {
    throw new Error('Missing booking selection context. Close the popup, select the booking cells again, and retry.');
  }

  if (!context.checkIn || !context.checkOut) {
    throw new Error('Missing check-in/check-out dates from the selected cells.');
  }

  if (!Array.isArray(context.bedIds) || !context.bedIds.length) {
    throw new Error('Missing bed IDs from the selected rows.');
  }

  if (!context.startRow || !context.endRow || !context.startCol || !context.endCol) {
    throw new Error('Missing selected range coordinates. Close the popup, select the booking cells again, and retry.');
  }
}

function getOrCreateManualEntriesSheet_(ss) {
  let sheet = ss.getSheetByName(WOLFHOUSE_CONFIG.manualEntriesSheetName);

  if (!sheet) {
    sheet = ss.insertSheet(WOLFHOUSE_CONFIG.manualEntriesSheetName);
  }

  return sheet;
}

function ensureManualHeaders_(sheet) {
  const headers = WOLFHOUSE_CONFIG.manualHeaders;
  const currentLastColumn = Math.max(sheet.getLastColumn(), headers.length);

  if (currentLastColumn < headers.length) {
    sheet.insertColumnsAfter(currentLastColumn, headers.length - currentLastColumn);
  }

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#1f4e78')
    .setFontColor('#ffffff');

  sheet.setFrozenRows(1);
}

function appendManualEntry_(sheet, rowObject) {
  ensureManualHeaders_(sheet);

  const headers = WOLFHOUSE_CONFIG.manualHeaders;
  const nextRow = Math.max(sheet.getLastRow() + 1, 2);
  const values = headers.map(header => rowObject[header] !== undefined ? rowObject[header] : '');

  sheet.getRange(nextRow, 1, 1, headers.length).setValues([values]);

  return nextRow;
}

function updateManualEntryRow_(sheet, rowNumber, rowObject) {
  ensureManualHeaders_(sheet);

  const headers = WOLFHOUSE_CONFIG.manualHeaders;
  const values = headers.map(header => rowObject[header] !== undefined ? rowObject[header] : '');

  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([values]);
}

function getHeaderIndexMap_(headers) {
  const map = {};

  headers.forEach((header, index) => {
    map[String(header || '').trim()] = index;
  });

  return map;
}

function findManualEntryRow_(ss, manualEntryId) {
  const sheet = ss.getSheetByName(WOLFHOUSE_CONFIG.manualEntriesSheetName);

  if (!sheet) {
    return { found: false };
  }

  ensureManualHeaders_(sheet);

  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), WOLFHOUSE_CONFIG.manualHeaders.length);

  if (lastRow < 2) {
    return { found: false };
  }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headerMap = getHeaderIndexMap_(headers);
  const idIndex = headerMap['Manual Entry ID'];

  if (idIndex === undefined) {
    return { found: false };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  for (let i = 0; i < values.length; i++) {
    const rowValues = values[i];
    const rowId = String(rowValues[idIndex] || '').trim();

    if (rowId === manualEntryId) {
      const rowObject = {};

      WOLFHOUSE_CONFIG.manualHeaders.forEach(header => {
        const index = headerMap[header];
        rowObject[header] = index === undefined ? '' : rowValues[index];
      });

      return {
        found: true,
        sheet,
        rowNumber: i + 2,
        rowObject
      };
    }
  }

  return { found: false };
}

function findManualEntryIdsInRange_(range) {
  const notes = range.getNotes();
  const ids = new Set();

  for (let r = 0; r < notes.length; r++) {
    for (let c = 0; c < notes[r].length; c++) {
      const note = String(notes[r][c] || '');
      const match = note.match(/Manual Entry ID:\s*(MAN-[A-Za-z0-9-]+)/i);

      if (match && match[1]) {
        ids.add(match[1]);
      }
    }
  }

  return Array.from(ids);
}

function paintManualBookingCells_(params) {
  const {
    planningSheet,
    context,
    manualEntryId,
    guestName,
    guestCount,
    packageName,
    depositPaid,
    status,
    paymentStatus,
    notes
  } = params;

  const range = planningSheet.getRange(
    context.startRow,
    context.startCol,
    context.endRow - context.startRow + 1,
    context.endCol - context.startCol + 1
  );

  const color = getManualPaintColor_(status, paymentStatus);
  const displayText = buildDisplayText_(guestName, paymentStatus, depositPaid, packageName);
  const noteText = buildNoteText_({
    manualEntryId,
    guestName,
    guestCount,
    packageName,
    depositPaid,
    checkIn: context.checkIn,
    checkOut: context.checkOut,
    bedIds: context.bedIds,
    status,
    paymentStatus,
    notes
  });

  range
    .setBackground(color)
    .setFontColor(WOLFHOUSE_CONFIG.colors.text)
    .setWrap(true)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setFontWeight('normal')
    .setNote(noteText)
    .setBorder(
      true,
      true,
      true,
      true,
      false,
      false,
      WOLFHOUSE_CONFIG.colors.border,
      SpreadsheetApp.BorderStyle.SOLID_MEDIUM
    );

  const firstCell = planningSheet.getRange(context.startRow, context.startCol);

  firstCell
    .setValue(displayText)
    .setFontWeight('bold')
    .setNote(noteText);
}

function repaintManualBookingById_(planningSheet, rowObject) {
  const manualEntryId = String(rowObject['Manual Entry ID'] || '').trim();

  if (!manualEntryId) {
    throw new Error('Missing Manual Entry ID.');
  }

  const lastRow = planningSheet.getLastRow();
  const lastCol = planningSheet.getLastColumn();

  const gridRange = planningSheet.getRange(
    WOLFHOUSE_CONFIG.firstBedRow,
    WOLFHOUSE_CONFIG.firstDateColumn,
    lastRow - WOLFHOUSE_CONFIG.firstBedRow + 1,
    lastCol - WOLFHOUSE_CONFIG.firstDateColumn + 1
  );

  const notesGrid = gridRange.getNotes();
  const matchingCells = [];

  for (let r = 0; r < notesGrid.length; r++) {
    for (let c = 0; c < notesGrid[r].length; c++) {
      const note = String(notesGrid[r][c] || '');

      if (note.includes(`Manual Entry ID: ${manualEntryId}`)) {
        matchingCells.push({
          row: WOLFHOUSE_CONFIG.firstBedRow + r,
          col: WOLFHOUSE_CONFIG.firstDateColumn + c
        });
      }
    }
  }

  if (!matchingCells.length) {
    throw new Error(`Could not find any Planning cells for ${manualEntryId}.`);
  }

  matchingCells.sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });

  const guestName = String(rowObject['Guest Name'] || '').trim();
  const guestCount = Number(rowObject['Guest Count'] || 1);
  const packageName = String(rowObject['Package'] || '').trim();
  const depositPaid = String(rowObject['Deposit Paid'] || '').trim();
  const status = String(rowObject['Status'] || 'Confirmed').trim();
  const paymentStatus = String(rowObject['Payment Status'] || 'waiting_payment').trim();
  const notes = String(rowObject['Notes'] || '').trim();
  const checkIn = normalizeSheetDate_(rowObject['Check In']);
  const checkOut = normalizeSheetDate_(rowObject['Check Out']);
  const bedIds = String(rowObject['Room / Bed'] || '').split(',').map(value => value.trim()).filter(Boolean);

  const color = getManualPaintColor_(status, paymentStatus);
  const displayText = buildDisplayText_(guestName, paymentStatus, depositPaid, packageName);
  const noteText = buildNoteText_({
    manualEntryId,
    guestName,
    guestCount,
    packageName,
    depositPaid,
    checkIn,
    checkOut,
    bedIds,
    status,
    paymentStatus,
    notes
  });

  matchingCells.forEach(cellInfo => {
    planningSheet.getRange(cellInfo.row, cellInfo.col)
      .setValue('')
      .setBackground(color)
      .setFontColor(WOLFHOUSE_CONFIG.colors.text)
      .setWrap(true)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setFontWeight('normal')
      .setNote(noteText);
  });

  const firstCell = matchingCells[0];

  planningSheet.getRange(firstCell.row, firstCell.col)
    .setValue(displayText)
    .setFontWeight('bold')
    .setNote(noteText);

  const minRow = Math.min(...matchingCells.map(cell => cell.row));
  const maxRow = Math.max(...matchingCells.map(cell => cell.row));
  const minCol = Math.min(...matchingCells.map(cell => cell.col));
  const maxCol = Math.max(...matchingCells.map(cell => cell.col));

  planningSheet.getRange(
    minRow,
    minCol,
    maxRow - minRow + 1,
    maxCol - minCol + 1
  ).setBorder(
    true,
    true,
    true,
    true,
    false,
    false,
    WOLFHOUSE_CONFIG.colors.border,
    SpreadsheetApp.BorderStyle.SOLID_MEDIUM
  );

  return matchingCells.length;
}

function buildDisplayText_(guestName, paymentStatus, depositPaid, packageName) {
  const labelParts = [guestName];

  if (paymentStatus) {
    labelParts.push(paymentStatus);
  }

  if (depositPaid) {
    labelParts.push(formatMoneyForDisplay_(depositPaid));
  }

  if (packageName) {
    labelParts.push(packageName);
  }

  labelParts.push('Manual');

  return labelParts.join(' - ');
}

function buildNoteText_(data) {
  return [
    `Manual Entry ID: ${data.manualEntryId}`,
    `Guest: ${data.guestName}`,
    data.packageName ? `Package: ${data.packageName}` : '',
    data.depositPaid ? `Deposit Paid: ${formatMoneyForDisplay_(data.depositPaid)}` : '',
    `Guest Count: ${data.guestCount}`,
    `Dates: ${data.checkIn} to ${data.checkOut}`,
    `Beds: ${(data.bedIds || []).join(', ')}`,
    `Status: ${data.status}`,
    `Payment Status: ${data.paymentStatus}`,
    data.notes ? `Notes: ${data.notes}` : '',
    `Sync Status: ${data.syncStatus || 'Ready'}`
  ].filter(Boolean).join('\n');
}

function formatMoneyForDisplay_(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  if (/^[€$£]/.test(raw)) {
    return raw;
  }

  const numberValue = Number(raw.replace(/,/g, ''));

  if (Number.isFinite(numberValue)) {
    return `€${numberValue}`;
  }

  return raw;
}

function getManualPaintColor_(status, paymentStatus) {
  const statusValue = String(status || '').toLowerCase();
  const paymentValue = String(paymentStatus || '').toLowerCase();

  if (statusValue === 'cancelled' || statusValue === 'expired') {
    return WOLFHOUSE_CONFIG.colors.cancelled;
  }

  if (statusValue === 'needs_review') {
    return WOLFHOUSE_CONFIG.colors.needsReview;
  }

  if (paymentValue === 'failed') {
    return WOLFHOUSE_CONFIG.colors.conflict;
  }

  if (statusValue === 'blocked') {
    return WOLFHOUSE_CONFIG.colors.blocked;
  }

  if (paymentValue === 'paid') {
    return WOLFHOUSE_CONFIG.colors.paid;
  }

  if (paymentValue === 'deposit_paid') {
    return WOLFHOUSE_CONFIG.colors.confirmed;
  }

  return WOLFHOUSE_CONFIG.colors.manualPending;
}

function normalizePackageName_(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  const map = {
    malibu: 'Malibu',
    uluwatu: 'Uluwatu',
    waimea: 'Waimea',
    custom: 'Custom'
  };

  return map[raw.toLowerCase()] || raw;
}

function normalizeSheetDate_(value) {
  if (!value) {
    return '';
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const raw = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const slashDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);

  if (slashDate) {
    const day = slashDate[1].padStart(2, '0');
    const month = slashDate[2].padStart(2, '0');
    let year = slashDate[3];

    if (year.length === 2) {
      year = `20${year}`;
    }

    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(raw);

  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  return '';
}

function addDaysIso_(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetweenIso_(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const diff = Math.round((end - start) / 86400000);

  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}

function makeManualEntryId_() {
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const random = Math.floor(1000 + Math.random() * 9000);

  return `MAN-${timestamp}-${random}`;
}