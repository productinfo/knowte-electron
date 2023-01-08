import { animate, state, style, transition, trigger } from '@angular/animations';
import { Component, HostListener, NgZone, OnInit, ViewEncapsulation } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { ActivatedRoute } from '@angular/router';
import * as remote from '@electron/remote';
import { BrowserWindow, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import * as electronLocalShortcut from 'electron-localshortcut';
import * as Quill from 'quill';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/internal/operators';
import { BaseSettings } from '../../core/base-settings';
import { ClipboardManager } from '../../core/clipboard-manager';
import { Constants } from '../../core/constants';
import { Operation } from '../../core/enums';
import { Logger } from '../../core/logger';
import { ProductInformation } from '../../core/product-information';
import { Strings } from '../../core/strings';
import { TasksCount } from '../../core/tasks-count';
import { Utils } from '../../core/utils';
import { AppearanceService } from '../../services/appearance/appearance.service';
import { CryptographyService } from '../../services/cryptography/cryptography.service';
import { PersistanceService } from '../../services/persistance/persistance.service';
import { PrintService } from '../../services/print/print.service';
import { NoteDetailsResult } from '../../services/results/note-details-result';
import { NoteOperationResult } from '../../services/results/note-operation-result';
import { SnackBarService } from '../../services/snack-bar/snack-bar.service';
import { SpellCheckService } from '../../services/spell-check/spell-check.service';
import { TranslatorService } from '../../services/translator/translator.service';
import { ConfirmationDialogComponent } from '../dialogs/confirmation-dialog/confirmation-dialog.component';
import { ErrorDialogComponent } from '../dialogs/error-dialog/error-dialog.component';
import { InputDialogComponent } from '../dialogs/input-dialog/input-dialog.component';
import { NotificationDialogComponent } from '../dialogs/notification-dialog/notification-dialog.component';
import { ContextMenuItemsEnabledState } from './context-menu-items-enabled-state';
import { NoteContextMenuFactory } from './note-context-menu-factory';
import { QuillFactory } from './quill-factory';
import { QuillTweaker } from './quill-tweaker';

@Component({
    selector: 'app-note',
    templateUrl: './note.component.html',
    styleUrls: ['./note.component.scss'],
    encapsulation: ViewEncapsulation.None,
    animations: [
        trigger('actionIconRotation', [
            state('default', style({ transform: 'rotate(0)' })),
            state('rotated', style({ transform: 'rotate(90deg)' })),
            transition('rotated => default', animate('250ms ease-out')),
            transition('default => rotated', animate('250ms ease-in')),
        ]),
    ],
})
export class NoteComponent implements OnInit {
    private quill: Quill;

    private globalEmitter: any = remote.getGlobal('globalEmitter');

    private isTitleDirty: boolean = false;
    private isTextDirty: boolean = false;

    private noteZoomPercentageChangedListener: any = this.noteZoomPercentageChangedHandler.bind(this);
    private noteMarkChangedListener: any = this.noteMarkChangedHandler.bind(this);
    private focusNoteListener: any = this.focusNoteHandler.bind(this);
    private closeNoteListener: any = this.closeNoteHandler.bind(this);

    private isEncrypted: boolean = false;
    private secretKey: string = '';
    private secretKeyHash: string = '';

    constructor(
        private print: PrintService,
        private activatedRoute: ActivatedRoute,
        private zone: NgZone,
        private dialog: MatDialog,
        private logger: Logger,
        private snackBar: SnackBarService,
        private translator: TranslatorService,
        private cryptography: CryptographyService,
        private persistance: PersistanceService,
        public settings: BaseSettings,
        public appearance: AppearanceService,
        public spellCheckService: SpellCheckService,
        private clipboard: ClipboardManager,
        private quillFactory: QuillFactory,
        private noteContextMenuFactory: NoteContextMenuFactory,
        private quillTweaker: QuillTweaker
    ) {}

    public noteId: string;
    public initialNoteTitle: string;
    public noteTitle: string;
    public isMarked: boolean;
    public noteTitleChanged: Subject<string> = new Subject<string>();
    public noteTextChanged: Subject<string> = new Subject<string>();
    public saveChangesAndCloseNoteWindow: Subject<string> = new Subject<string>();
    public canPerformActions: boolean = false;
    public isBusy: boolean = false;
    public actionIconRotation: string = 'default';
    public canSearch: boolean = false;

    private isSecretKeyCorrect(): boolean {
        return this.cryptography.createHash(this.secretKey) === this.secretKeyHash;
    }

    public async ngOnInit(): Promise<void> {
        this.activatedRoute.queryParams.subscribe(async (params) => {
            this.noteId = params['id'];
            this.globalEmitter.emit(Constants.getNoteDetailsEvent, this.noteId, this.getNoteDetailsCallback.bind(this));

            // TODO: this is an ugly hack
            while (Strings.isNullOrWhiteSpace(this.noteTitle)) {
                await Utils.sleep(50);
            }

            this.addGlobalListeners();

            if (this.isEncrypted) {
                let isClosing: boolean = false;

                while (!this.isSecretKeyCorrect() && !isClosing) {
                    if (!(await this.requestSecretKeyAsync())) {
                        isClosing = true;
                        window.close();
                    } else {
                        if (!this.isSecretKeyCorrect()) {
                            const notificationTitle: string = await this.translator.getAsync('NotificationTitles.IncorrectKey');
                            const notificationText: string = await this.translator.getAsync('NotificationTexts.SecretKeyIncorrect');
                            const dialogRef: MatDialogRef<NotificationDialogComponent> = this.dialog.open(NotificationDialogComponent, {
                                width: '450px',
                                data: { notificationTitle: notificationTitle, notificationText: notificationText },
                            });

                            await dialogRef.afterClosed().toPromise();
                        }
                    }
                }
            }

            this.quill = await this.quillFactory.createAsync('#editor', this.performUndo.bind(this), this.performRedo.bind(this));
            this.quillTweaker.forcePasteOfUnformattedText(this.quill);
            this.quillTweaker.assignActionToControlKeyCombination(this.quill, 'Y', this.performRedo.bind(this));
            this.quillTweaker.assignActionToTextChange(this.quill, this.onNoteTextChange.bind(this));

            this.setEditorZoomPercentage();
            await this.setToolbarTooltipsAsync();
            this.addSubscriptions();
            this.addDocumentListeners();

            await this.getNoteContentAsync();
            this.applySearch();

            window.webContents.on('context-menu', (event, contextMenuParams) => {
                const hasSelectedText: boolean = this.hasSelectedRange();
                const contextMenuItemsEnabledState: ContextMenuItemsEnabledState = new ContextMenuItemsEnabledState(
                    hasSelectedText,
                    this.clipboard.containsText() || this.clipboard.containsImage()
                );
                this.noteContextMenuFactory.createAsync(
                    window.webContents,
                    contextMenuParams,
                    contextMenuItemsEnabledState,
                    this.performCut.bind(this),
                    this.performCopy.bind(this),
                    this.performPaste.bind(this),
                    this.performDelete.bind(this)
                );
            });
        });

        const window: BrowserWindow = remote.getCurrentWindow();

        electronLocalShortcut.register(window, 'ESC', () => {
            if (this.settings.closeNotesWithEscape) {
                window.close();
            }
        });
    }

    private addSubscriptions(): void {
        this.noteTitleChanged.pipe(debounceTime(Constants.noteSaveTimeoutMilliseconds)).subscribe((finalNoteTitle) => {
            this.globalEmitter.emit(
                Constants.setNoteTitleEvent,
                this.noteId,
                this.initialNoteTitle,
                finalNoteTitle,
                this.setNoteTitleCallbackAsync.bind(this)
            );
        });

        this.noteTextChanged.pipe(debounceTime(Constants.noteSaveTimeoutMilliseconds)).subscribe(async (_) => {
            this.globalEmitter.emit(
                Constants.setNoteTextEvent,
                this.noteId,
                this.quill.getText(),
                this.isEncrypted,
                this.secretKey,
                this.getTasksCount(),
                this.setNoteTextCallbackAsync.bind(this)
            );
        });

        this.saveChangesAndCloseNoteWindow.pipe(debounceTime(Constants.noteWindowCloseTimeoutMilliseconds)).subscribe((_) => {
            this.saveAndClose();
        });
    }

    private addDocumentListeners(): void {
        document.onpaste = (e: ClipboardEvent) => {
            if (this.clipboard.containsImage()) {
                // Clipboard contains image. Cancel default paste (it pastes the path to the image instead of the image data).
                e.preventDefault();

                // Execute our own paste, which pastes the image data.
                this.pasteImageFromClipboard();
            }
        };

        document.addEventListener('wheel', (e: WheelEvent) => {
            if (e.ctrlKey) {
                this.setEditorZoomPercentByMouseScroll(e.deltaY);
            }
        });
    }

    private performUndo(): void {
        if (this.quill != undefined && this.quill.history != undefined) {
            try {
                this.quill.history.undo();
            } catch (error) {
                this.logger.error(`Could not perform undo. Cause: ${error}`, 'NoteComponent', 'performUndo');
            }
        }
    }

    private performRedo(): void {
        if (this.quill != undefined && this.quill.history != undefined) {
            try {
                this.quill.history.redo();
            } catch (error) {
                this.logger.error(`Could not perform redo. Cause: ${error}`, 'NoteComponent', 'performRedo');
            }
        }
    }

    private async setToolbarTooltipsAsync(): Promise<void> {
        // See: https://github.com/quilljs/quill/issues/650
        const toolbarElement: Element = document.querySelector('.ql-toolbar');
        toolbarElement.querySelector('span.ql-background').setAttribute('title', await this.translator.getAsync('Tooltips.Highlight'));
        toolbarElement.querySelector('button.ql-undo').setAttribute('title', await this.translator.getAsync('Tooltips.Undo'));
        toolbarElement.querySelector('button.ql-redo').setAttribute('title', await this.translator.getAsync('Tooltips.Redo'));
        toolbarElement.querySelector('button.ql-bold').setAttribute('title', await this.translator.getAsync('Tooltips.Bold'));
        toolbarElement.querySelector('button.ql-italic').setAttribute('title', await this.translator.getAsync('Tooltips.Italic'));
        toolbarElement.querySelector('button.ql-underline').setAttribute('title', await this.translator.getAsync('Tooltips.Underline'));
        toolbarElement.querySelector('button.ql-strike').setAttribute('title', await this.translator.getAsync('Tooltips.Strikethrough'));

        toolbarElement
            .querySelector('[class="ql-header"][value="1"]')
            .setAttribute('title', await this.translator.getAsync('Tooltips.Heading1'));
        toolbarElement
            .querySelector('[class="ql-header"][value="2"]')
            .setAttribute('title', await this.translator.getAsync('Tooltips.Heading2'));

        toolbarElement
            .querySelector('[class="ql-list"][value="ordered"]')
            .setAttribute('title', await this.translator.getAsync('Tooltips.NumberedList'));
        toolbarElement
            .querySelector('[class="ql-list"][value="bullet"]')
            .setAttribute('title', await this.translator.getAsync('Tooltips.BulletedList'));
        toolbarElement
            .querySelector('[class="ql-list"][value="check"]')
            .setAttribute('title', await this.translator.getAsync('Tooltips.TaskList'));

        toolbarElement.querySelector('button.ql-link').setAttribute('title', await this.translator.getAsync('Tooltips.Link'));
        toolbarElement.querySelector('button.ql-blockquote').setAttribute('title', await this.translator.getAsync('Tooltips.Quote'));
        toolbarElement.querySelector('button.ql-code-block').setAttribute('title', await this.translator.getAsync('Tooltips.Code'));
        toolbarElement.querySelector('button.ql-image').setAttribute('title', await this.translator.getAsync('Tooltips.Image'));

        toolbarElement.querySelector('button.ql-clean').setAttribute('title', await this.translator.getAsync('Tooltips.ClearFormatting'));
    }

    public onNoteTitleChange(newNoteTitle: string): void {
        this.isTitleDirty = true;
        this.clearSearch();
        this.noteTitleChanged.next(newNoteTitle);
    }

    public onNoteTextChange(): void {
        this.isTextDirty = true;
        this.clearSearch();
        this.noteTextChanged.next('');
    }

    // ngOnDestroy doesn't tell us when a note window is closed, so we use this event instead.
    @HostListener('window:beforeunload', ['$event'])
    public beforeunloadHandler(event: any): void {
        this.logger.info(`Detected closing of note with id=${this.noteId}`, 'NoteComponent', 'beforeunloadHandler');

        // Prevents closing of the window
        if (this.isTitleDirty || this.isTextDirty) {
            this.isTitleDirty = false;
            this.isTextDirty = false;

            this.logger.info(
                `Note with id=${this.noteId} is dirty. Preventing close to save changes first.`,
                'NoteComponent',
                'beforeunloadHandler'
            );
            event.preventDefault();
            event.returnValue = '';

            this.saveChangesAndCloseNoteWindow.next('');
        } else {
            this.logger.info(`Note with id=${this.noteId} is clean. Closing directly.`, 'NoteComponent', 'beforeunloadHandler');
            this.cleanup();
        }
    }

    public onTitleKeydown(event: any): void {
        if (event.key === 'Enter' || event.key === 'Tab') {
            // Make sure enter is not applied to the editor
            event.preventDefault();

            // Sets focus to editor when pressing enter on title
            this.quill.setSelection(0, 0);
        }
    }

    public toggleNoteMark(): void {
        this.hideActionButtonsDelayedAsync();
        this.globalEmitter.emit(Constants.setNoteMarkEvent, this.noteId, !this.isMarked);
    }

    public async exportNoteToPdfAsync(): Promise<void> {
        this.hideActionButtons();

        const options: SaveDialogOptions = { defaultPath: Utils.getPdfExportPath(remote.app.getPath('documents'), this.noteTitle) };
        const saveDialogReturnValue: SaveDialogReturnValue = await remote.dialog.showSaveDialog(undefined, options);

        if (saveDialogReturnValue.filePath != undefined) {
            this.print.exportToPdfAsync(saveDialogReturnValue.filePath, this.noteTitle, this.quill.root.innerHTML);
        }
    }

    public async printNoteAsync(): Promise<void> {
        this.hideActionButtons();
        this.print.printAsync(this.noteTitle, this.quill.root.innerHTML);
    }

    public async deleteNoteAsync(): Promise<void> {
        this.hideActionButtons();

        const title: string = await this.translator.getAsync('DialogTitles.ConfirmDeleteNote');
        const text: string = await this.translator.getAsync('DialogTexts.ConfirmDeleteNote', { noteTitle: this.noteTitle });

        const dialogRef: MatDialogRef<ConfirmationDialogComponent> = this.dialog.open(ConfirmationDialogComponent, {
            width: '450px',
            data: { dialogTitle: title, dialogText: text },
        });

        dialogRef.afterClosed().subscribe(async (result) => {
            if (result) {
                this.globalEmitter.emit(Constants.deleteNoteEvent, this.noteId);

                const window: BrowserWindow = remote.getCurrentWindow();
                window.close();
            }
        });
    }

    public onFixedContentClick(): void {
        this.hideActionButtons();
    }

    public toggleShowActions(): void {
        this.canPerformActions = !this.canPerformActions;
        this.rotateActionsButton();
    }

    public rotateActionsButton(): void {
        this.actionIconRotation = this.canPerformActions ? 'rotated' : 'default';
    }

    public async exportNoteAsync(): Promise<void> {
        this.hideActionButtons();
        this.isBusy = true;

        const options: SaveDialogOptions = { defaultPath: Utils.getNoteExportPath(remote.app.getPath('documents'), this.noteTitle) };
        const saveDialogReturnValue: SaveDialogReturnValue = await remote.dialog.showSaveDialog(undefined, options);

        try {
            if (saveDialogReturnValue.filePath != undefined && saveDialogReturnValue.filePath.length > 0) {
                await this.persistance.exportNoteAsync(
                    saveDialogReturnValue.filePath,
                    this.noteTitle,
                    this.quill.getText(),
                    this.getNoteJsonContent()
                );
                this.snackBar.noteExportedAsync(this.noteTitle);
            }

            this.isBusy = false;
        } catch (error) {
            this.isBusy = false;
            this.logger.error(
                `An error occurred while exporting the note with title '${this.noteTitle}'. Cause: ${error}`,
                'NoteComponent',
                'exportNoteAsync'
            );

            const errorText: string = await this.translator.getAsync('ErrorTexts.ExportNoteError', { noteTitle: this.noteTitle });

            this.dialog.open(ErrorDialogComponent, {
                width: '450px',
                data: { errorText: errorText },
            });
        }
    }

    public async requestSecretKeyAsync(): Promise<boolean> {
        const titleText: string = await this.translator.getAsync('DialogTitles.NoteIsEncrypted');
        const placeholderText: string = await this.translator.getAsync('Input.SecretKey');

        const data: any = { titleText: titleText, inputText: '', placeholderText: placeholderText };

        const dialogRef: MatDialogRef<InputDialogComponent> = this.dialog.open(InputDialogComponent, {
            width: '450px',
            data: data,
        });

        const result: any = await dialogRef.afterClosed().toPromise();

        if (result) {
            this.secretKey = data.inputText;

            return true;
        }

        return false;
    }

    public async encryptNoteAsync(): Promise<void> {
        this.hideActionButtons();

        const titleText: string = await this.translator.getAsync('DialogTitles.EncryptNote');
        const placeholderText: string = await this.translator.getAsync('Input.SecretKey');

        const data: any = { titleText: titleText, inputText: '', placeholderText: placeholderText };

        const dialogRef: MatDialogRef<InputDialogComponent> = this.dialog.open(InputDialogComponent, {
            width: '450px',
            data: data,
        });

        dialogRef.afterClosed().subscribe(async (result: any) => {
            if (result) {
                this.isEncrypted = true;
                this.secretKey = data.inputText;
                this.globalEmitter.emit(Constants.encryptNoteEvent, this.noteId, this.secretKey);
                this.globalEmitter.emit(
                    Constants.setNoteTextEvent,
                    this.noteId,
                    this.quill.getText(),
                    this.isEncrypted,
                    this.secretKey,
                    this.getTasksCount(),
                    this.setNoteTextCallbackAsync.bind(this)
                );
            }
        });
    }

    public async decryptNoteAsync(): Promise<void> {
        this.hideActionButtons();

        const title: string = await this.translator.getAsync('DialogTitles.ConfirmDecryptNote');
        const text: string = await this.translator.getAsync('DialogTexts.ConfirmDecryptNote');

        const dialogRef: MatDialogRef<ConfirmationDialogComponent> = this.dialog.open(ConfirmationDialogComponent, {
            width: '450px',
            data: { dialogTitle: title, dialogText: text },
        });

        dialogRef.afterClosed().subscribe(async (result: any) => {
            if (result) {
                this.isEncrypted = false;
                this.secretKey = '';
                this.globalEmitter.emit(Constants.decryptNoteEvent, this.noteId);
                this.globalEmitter.emit(
                    Constants.setNoteTextEvent,
                    this.noteId,
                    this.quill.getText(),
                    this.isEncrypted,
                    this.secretKey,
                    this.getTasksCount(),
                    this.setNoteTextCallbackAsync.bind(this)
                );
            }
        });
    }

    private hasSelectedRange(): boolean {
        const range: any = this.quill.getSelection();

        if (range && range.length > 0) {
            return true;
        }

        return false;
    }

    private performCut(): void {
        const range: any = this.quill.getSelection();

        if (!range || range.length === 0) {
            return;
        }

        const text: string = this.quill.getText(range.index, range.length);
        this.clipboard.writeText(text);
        this.quill.deleteText(range.index, range.length);
    }

    private performCopy(): void {
        const range: any = this.quill.getSelection();

        if (!range || range.length === 0) {
            return;
        }

        const text: string = this.quill.getText(range.index, range.length);
        this.clipboard.writeText(text);
    }

    private performPaste(): void {
        if (this.clipboard.containsImage()) {
            // Image found on clipboard. Try to paste as JPG.
            this.pasteImageFromClipboard();
        } else {
            // No image found on clipboard. Try to paste as text.
            this.pastTextFromClipboard();
        }
    }

    private performDelete(): void {
        const range: any = this.quill.getSelection();

        if (!range || range.length === 0) {
            return;
        }

        this.quill.deleteText(range.index, range.length);
    }

    private pasteImageFromClipboard(): void {
        try {
            this.insertImage(this.clipboard.readImage());
        } catch (error) {
            this.logger.error('Could not paste as image', 'NoteComponent', 'performPaste');
        }
    }

    private pastTextFromClipboard(): void {
        const range: any = this.quill.getSelection();

        if (!range) {
            return;
        }

        const clipboardText: string = this.clipboard.readText();

        if (clipboardText) {
            this.quill.insertText(range.index, clipboardText);
        }
    }

    private removeGlobalListeners(): void {
        this.globalEmitter.removeListener(Constants.noteMarkChangedEvent, this.noteMarkChangedListener);
        this.globalEmitter.removeListener(Constants.focusNoteEvent, this.focusNoteListener);
        this.globalEmitter.removeListener(Constants.closeNoteEvent, this.closeNoteListener);
        this.globalEmitter.removeListener(Constants.noteZoomPercentageChangedEvent, this.noteZoomPercentageChangedListener);
    }

    private addGlobalListeners(): void {
        this.globalEmitter.on(Constants.noteMarkChangedEvent, this.noteMarkChangedListener);
        this.globalEmitter.on(Constants.focusNoteEvent, this.focusNoteListener);
        this.globalEmitter.on(Constants.closeNoteEvent, this.closeNoteListener);
        this.globalEmitter.on(Constants.noteZoomPercentageChangedEvent, this.noteZoomPercentageChangedListener);
    }

    private cleanup(): void {
        this.globalEmitter.emit(Constants.setNoteOpenEvent, this.noteId, false);
        this.removeGlobalListeners();
    }

    private insertImage(file: any): void {
        const reader: FileReader = new FileReader();

        reader.onload = (e: any) => {
            const img: HTMLImageElement = document.createElement('img');
            img.src = e.target.result;

            const range: Range = window.getSelection().getRangeAt(0);
            range.deleteContents();
            range.insertNode(img);
        };

        reader.readAsDataURL(file);
    }

    private saveAndClose(): void {
        this.globalEmitter.emit(
            Constants.setNoteTitleEvent,
            this.noteId,
            this.initialNoteTitle,
            this.noteTitle,
            async (result: NoteOperationResult) => {
                const setTitleOperation: Operation = result.operation;
                await this.setNoteTitleCallbackAsync(result);

                this.globalEmitter.emit(
                    Constants.setNoteTextEvent,
                    this.noteId,
                    this.quill.getText(),
                    this.isEncrypted,
                    this.secretKey,
                    this.getTasksCount(),
                    async (operation: Operation) => {
                        const setTextOperation: Operation = operation;
                        await this.setNoteTextCallbackAsync(operation);

                        // Close is only allowed when saving both title and text is successful
                        if (setTitleOperation === Operation.Success && setTextOperation === Operation.Success) {
                            this.logger.info(`Closing note with id=${this.noteId} after saving changes.`, 'NoteComponent', 'saveAndClose');
                            this.cleanup();
                            const window: BrowserWindow = remote.getCurrentWindow();
                            window.close();
                        }
                    }
                );
            }
        );
    }

    private getNoteDetailsCallback(result: NoteDetailsResult): void {
        this.zone.run(() => {
            this.initialNoteTitle = result.noteTitle;
            this.noteTitle = result.noteTitle;
            this.isMarked = result.isMarked;
            this.isEncrypted = result.isEncrypted;
            this.secretKeyHash = result.secretKeyHash;

            this.setWindowTitle(result.noteTitle);
        });
    }

    private setEditorZoomPercentage(): void {
        const pFontSize: number = (13 * this.settings.noteZoomPercentage) / 100;
        const h1FontSize: number = pFontSize * 1.7;
        const h2FontSize: number = pFontSize * 1.5;

        const element: HTMLElement = document.documentElement;

        element.style.setProperty('--editor-p-font-size', pFontSize + 'px');
        element.style.setProperty('--editor-h1-font-size', h1FontSize + 'px');
        element.style.setProperty('--editor-h2-font-size', h2FontSize + 'px');
    }

    private setEditorZoomPercentByMouseScroll(mouseWheelDeltaY: number): void {
        const availableNoteZoomPercentages: number[] = Constants.noteZoomPercentages;
        const currentNoteZoomPercentage: number = this.settings.noteZoomPercentage;
        const minimumNoteZoomPercentage: number = Math.min(...availableNoteZoomPercentages);
        const maximumNoteZoomPercentage: number = Math.max(...availableNoteZoomPercentages);

        if (mouseWheelDeltaY < 0) {
            // scrolling up
            if (currentNoteZoomPercentage < maximumNoteZoomPercentage) {
                this.settings.noteZoomPercentage += 10;
            }
        } else {
            // scrolling down
            if (currentNoteZoomPercentage > minimumNoteZoomPercentage) {
                this.settings.noteZoomPercentage -= 10;
            }
        }

        this.globalEmitter.emit(Constants.noteZoomPercentageChangedEvent);

        this.setEditorZoomPercentage();
    }

    private setWindowTitle(noteTitle: string): void {
        const window: BrowserWindow = remote.getCurrentWindow();
        window.setTitle(`${ProductInformation.applicationName} - ${noteTitle}`);
    }

    private noteMarkChangedHandler(noteId: string, isMarked: boolean): void {
        if (this.noteId === noteId) {
            this.zone.run(() => (this.isMarked = isMarked));
        }
    }

    private focusNoteHandler(noteId: string): void {
        if (this.noteId === noteId) {
            const window: BrowserWindow = remote.getCurrentWindow();

            if (window.isMinimized()) {
                window.minimize(); // Workaround for notes not getting restored on Linux
                window.restore();
            }

            window.focus();
        }
    }

    private closeNoteHandler(noteId: string): void {
        if (this.noteId === noteId) {
            const window: BrowserWindow = remote.getCurrentWindow();
            window.close();
        }
    }

    private noteZoomPercentageChangedHandler(): void {
        this.setEditorZoomPercentage();
    }

    public clearSearch(): void {
        const window: BrowserWindow = remote.getCurrentWindow();
        window.webContents.stopFindInPage('keepSelection');
    }

    private applySearch(): void {
        this.globalEmitter.emit(Constants.getSearchTextEvent, this.getSearchTextCallback.bind(this));
    }

    private getSearchTextCallback(searchText: string): void {
        const window: BrowserWindow = remote.getCurrentWindow();

        if (searchText && searchText.length > 0) {
            const searchTextPieces: string[] = searchText.trim().split(' ');

            // For now, we can only search for 1 word.
            window.webContents.findInPage(searchTextPieces[0]);
        }
    }

    private async setNoteTitleCallbackAsync(result: NoteOperationResult): Promise<void> {
        if (result.operation === Operation.Blank) {
            this.zone.run(() => (this.noteTitle = this.initialNoteTitle));
            this.snackBar.noteTitleCannotBeEmptyAsync();
        } else if (result.operation === Operation.Error) {
            this.zone.run(() => (this.noteTitle = this.initialNoteTitle));
            const errorText: string = await this.translator.getAsync('ErrorTexts.RenameNoteError', { noteTitle: this.initialNoteTitle });

            this.zone.run(() => {
                this.dialog.open(ErrorDialogComponent, {
                    width: '450px',
                    data: { errorText: errorText },
                });
            });
        } else if (result.operation === Operation.Success) {
            this.zone.run(() => {
                this.initialNoteTitle = result.noteTitle;
                this.noteTitle = result.noteTitle;
                this.setWindowTitle(result.noteTitle);
            });
        } else {
            // Do nothing
        }

        this.isTitleDirty = false;
    }

    private async setNoteTextCallbackAsync(operation: Operation): Promise<void> {
        let showErrorDialog = false;

        if (operation === Operation.Success) {
            try {
                this.persistance.updateNoteContent(this.noteId, this.getNoteJsonContent(), this.isEncrypted, this.secretKey);
            } catch (error) {
                this.logger.error(
                    `Could not save content for the note with id='${this.noteId}'. Cause: ${error}`,
                    'NoteComponent',
                    'setNoteTextCallbackAsync'
                );
                showErrorDialog = true;
            }
        } else if (operation === Operation.Error) {
            showErrorDialog = true;
        } else {
            // Do nothing
        }

        if (showErrorDialog) {
            const errorText: string = await this.translator.getAsync('ErrorTexts.UpdateNoteContentError');

            this.zone.run(() => {
                this.dialog.open(ErrorDialogComponent, {
                    width: '450px',
                    data: { errorText: errorText },
                });
            });
        }

        this.isTextDirty = false;
    }

    private async getNoteContentAsync(): Promise<void> {
        // Details from data store
        while (!this.noteTitle) {
            // While, is a workaround for auto reload. CollectionService is not ready to
            // listen to events after a auto reload. So we keep trying, until it responds.
            await Utils.sleep(50);
            this.globalEmitter.emit(Constants.getNoteDetailsEvent, this.noteId, this.getNoteDetailsCallback.bind(this));
        }

        // Details from note file
        try {
            const noteContent: string = await this.persistance.getNoteContentAsync(this.noteId, this.isEncrypted, this.secretKey);

            if (noteContent) {
                // We can only parse to json if there is content
                this.logger.info(`Setting the content for the note with id='${this.noteId}'`, 'NoteComponent', 'getNoteDetailsAsync');
                this.quill.setContents(JSON.parse(noteContent), 'silent');
                this.quill.history.clear();
            } else {
                this.logger.error(
                    `Could not get the content for the note with id='${this.noteId}'`,
                    'NoteComponent',
                    'getNoteDetailsAsync'
                );
            }
        } catch (error) {
            this.logger.error(
                `Could not get the content for the note with id='${this.noteId}'. Cause: ${error}`,
                'NoteComponent',
                'getNoteDetailsAsync'
            );

            const errorText: string = await this.translator.getAsync('ErrorTexts.GetNoteContentError');

            this.dialog.open(ErrorDialogComponent, {
                width: '450px',
                data: { errorText: errorText },
            });
        }
    }

    private hideActionButtons(): void {
        this.canPerformActions = false;
        this.rotateActionsButton();
    }

    private async hideActionButtonsDelayedAsync(): Promise<void> {
        await Utils.sleep(500);
        this.canPerformActions = false;
        this.rotateActionsButton();
    }

    public heading1(event: any): void {
        this.applyHeading(1);
    }

    public heading2(event: any): void {
        this.applyHeading(2);
    }

    private applyHeading(headingSize: number): void {
        const range: any = this.quill.getSelection();
        const format: any = this.quill.getFormat(range.index, range.length);
        const formatString: string = JSON.stringify(format);

        const selectionContainsHeader: boolean = !formatString.includes(`"header":${headingSize}`);

        if (selectionContainsHeader) {
            this.quill.format('header', headingSize);
        } else {
            this.quill.removeFormat(range.index, range.length);
        }
    }

    public strikeThrough(event: any): void {
        const range: any = this.quill.getSelection();
        const format: any = this.quill.getFormat(range.index, range.length);
        const formatString: string = JSON.stringify(format);

        const applyStrikeThrough: boolean = !formatString.includes('strike');
        this.quill.formatText(range.index, range.length, 'strike', applyStrikeThrough);
    }

    private getTasksCount(): TasksCount {
        const noteContent: string = this.getNoteJsonContent();
        const openTasksCount: number = (noteContent.match(/"list":"unchecked"/g) || []).length;
        const closedTasksCount: number = (noteContent.match(/"list":"checked"/g) || []).length;

        return new TasksCount(openTasksCount, closedTasksCount);
    }

    private getNoteJsonContent(): string {
        return JSON.stringify(this.quill.getContents());
    }
}
