#!/usr/bin/env python3
"""Writes the text files the text-to-speech test opens.

Each file is built from its bytes here, so the test compares what the page
puts in the box with text that was never read back from the page:
Notepad's UTF-8 with a byte order mark and CR LF line ends, PowerShell's
UTF-16 LE with a BOM, UTF-16 BE, Windows-1252 text (once behind a UTF-8
BOM), files whose first bytes name another format (PDF, ZIP/Word, PNG) and
one plain text file that only starts like a PDF.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, data):
    with open(os.path.join(HERE, name), 'wb') as f:
        f.write(data)


write('notepad-utf8-bom.txt', b'\xef\xbb\xbf' + 'Hello from Notepad.\r\nSecond line, café.\r\n'.encode('utf-8'))
write('powershell-utf16.txt', b'\xff\xfe' + 'Grüße aus PowerShell. 👋\r\n'.encode('utf-16-le'))
write('utf16-be.txt', b'\xfe\xff' + 'Big-endian text.'.encode('utf-16-be'))
write('legacy-1252.txt', 'Café naïve – 5 €'.encode('cp1252'))
write('bom-then-1252.txt', b'\xef\xbb\xbf' + 'Crème brûlée'.encode('cp1252'))
write('report.pdf', b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Length 5 >>\nstream\n\x00\x01\x02\x03\x04\nendstream\nendobj\n%%EOF\n')
write('letter.docx', b'PK\x03\x04' + bytes(range(256)) * 4)
write('picture.png', b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89')
write('looks-like-pdf.txt', b'%PDF-1.4 is the version line of the oldest file in my notes.\n')
write('blank.txt', b'\r\n  \r\n')
print('written to', HERE)
