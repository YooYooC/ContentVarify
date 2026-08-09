# Bias Lens Chrome extension

Bias Lens analyzes selected text or the main article on the current page using the repository's on-device TF-IDF retrieval engine and calibrated logistic-regression classifier.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository root: `/Users/yoyocai/CV2 copy`.
5. Pin **Bias Lens** to the toolbar.

Click the toolbar icon to open the reader in Chrome's side panel. You can then:

- Highlight text and click **Selection**.
- Click **Article** to extract the current page's main readable content.
- Paste text and click **Analyze text**.
- Right-click highlighted text and choose **Analyze selected text with Bias Lens**.

## Privacy and permissions

Analysis runs locally in the extension. No article or selected text is uploaded.

- `activeTab` and `scripting`: read text only from the current page after an extension action.
- `sidePanel`: show analysis beside the article.
- `contextMenus`: add the selected-text shortcut.
- `storage`: pass a selected passage from the context menu to the side panel.

Chrome blocks extensions from reading protected pages such as `chrome://` pages and the Chrome Web Store.

## Model limitations

The output is evidence-based similarity, not a diagnosis of a person or proof that an article is false. The model can only recognize patterns represented by its labeled examples. Treat low-confidence and thin-data results as prompts for closer reading.
