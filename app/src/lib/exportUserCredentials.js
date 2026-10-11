// New-user credential handoff, as an .xlsx download triggered right after
// creation succeeds. The admin is the only person who ever has this
// plaintext password in hand (it's typed into the create-user form, never
// stored or returned by the backend afterwards, see
// createUserRequest/IdentityHandler.Create in identity_handler.go, which
// only ever returns the created `user` object, never the password back).
// So this has to be built from what the admin just submitted, at the
// moment of submission, there is no later API call that could reconstruct
// it.
export async function downloadUserCredentialsXlsx({ username, email, password, role }) {
  // exceljs is a large dependency (~900KB minified) and only ever needed at
  // the instant a user is created, a static import pulled it into the
  // Identity page's main bundle, bloating a page that most loads never
  // trigger this code path on. Dynamic import keeps it in its own
  // lazy-loaded chunk instead.
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PAM Console'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Credentials')
  sheet.columns = [
    { header: 'Field', key: 'field', width: 22 },
    { header: 'Value', key: 'value', width: 48 },
  ]
  sheet.getRow(1).font = { bold: true }

  sheet.addRows([
    { field: 'Username', value: username },
    { field: 'Email', value: email },
    { field: 'Temporary password', value: password },
    { field: 'Role', value: role || 'user' },
    { field: 'Login URL', value: window.location.origin },
  ])

  sheet.addRow([])
  const noteRow = sheet.addRow([
    'This file contains a plaintext password. Share it with the new user over a secure channel and delete it afterwards. The user should change this password on first login.',
  ])
  noteRow.font = { italic: true, color: { argb: 'FF8A6D3B' } }
  sheet.mergeCells(`A${noteRow.number}:B${noteRow.number}`)
  noteRow.getCell(1).alignment = { wrapText: true }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${username}-credentials.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
