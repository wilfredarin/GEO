/**
 * ============================================================================
 * EXPORT ENGINE: CLONE & SHARE WORKSPACE WITH QC TEAM
 * Creates an exact workspace duplicate, shares it with target stakeholders,
 * and renders an accessible visual interface component linking directly to it.
 * ============================================================================
 */
function exportWorkspaceToQC() {
  var ui = SpreadsheetApp.getUi();
  var currentSs = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Prompt Confirmation to prevent accidental execution
  var confirm = ui.alert(
    "Export Confirmation", 
    "This will create a new, dedicated workspace clone for the QC Team and share it automatically. Do you want to proceed?", 
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  try {
    // 2. Generate timestamped structural filename
    var dateString = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
    var clonedName = "QC_Review_Workspace_[" + currentSs.getName() + "]_" + dateString;
    
    // 3. Make an end-to-end exact file system copy of the Spreadsheet
    var currentFile = DriveApp.getFileById(currentSs.getId());
    var clonedFile = currentFile.makeCopy(clonedName);
    var clonedSs = SpreadsheetApp.openById(clonedFile.getId());
    
    // 4. Clean up unnecessary Master data sheets from the QC Workspace if present
    // Adjust these names if you want to keep or drop additional backend tabs
    var internalMasterTabs = ["Mapfacts_Snapshot", "Comparison_Agent_Output"];
    internalMasterTabs.forEach(function(tabName) {
      var targetTab = clonedSs.getSheetByName(tabName);
      if (targetTab) {
        clonedSs.deleteSheet(targetTab);
      }
    });
    
    // 5. Securely allocate access rights to target email addresses
    var targetReviewers = ["qcteam@google.com", "abc@google.com"];
    targetReviewers.forEach(function(email) {
      clonedFile.addEditor(email);
    });
    
    // 6. Generate an interactive HTML Dialog containing the deep link shortcut
    var sheetUrl = clonedSs.getUrl();
    var htmlContent = 
      '<div style="font-family: \'Google Sans\', Roboto, Arial, sans-serif; padding: 15px; color: #3c4043;">' +
        '<h3 style="color: #1a73e8; margin-top: 0;">Workspace Created Successfully!</h3>' +
        '<p style="font-size: 13px; line-height: 1.5; color: #5f6368;">' +
          'An exact clone has been provisioned and shared with <b>qcteam@google.com</b> and <b>sameer@google.com</b> with editor access permissions.' +
        '</p>' +
        '<div style="margin: 25px 0 15px 0; text-align: center;">' +
          '<a href="' + sheetUrl + '" target="_blank" style="' +
            'background-color: #1a73e8; ' +
            'color: white; ' +
            'padding: 12px 24px; ' +
            'text-decoration: none; ' +
            'font-weight: 500; ' +
            'font-size: 14px; ' +
            'border-radius: 4px; ' +
            'box-shadow: 0 1px 3px rgba(60,64,67,0.3); ' +
            'display: inline-block;' +
          '">Open QC Workspace</a>' +
        '</div>' +
      '</div>';
      
    var htmlOutput = HtmlService.createHtmlOutput(htmlContent)
        .setWidth(450)
        .setHeight(200);
        
    ui.showModalDialog(htmlOutput, "Deployment Engine Status");
    
  } catch (error) {
    ui.alert("Export Architecture Failure: " + error.toString());
  }
}