"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var rxjs_1 = require("rxjs");
var noteRenamedArgs_1 = require("./noteRenamedArgs");
var noteOperation_1 = require("./noteOperation");
var electron_log_1 = require("electron-log");
var noteMarkChangedArgs_1 = require("./noteMarkChangedArgs");
/**
 * Angular services cannot be configured as singletons across Electron windows. So we use this class, which we
 * set as a global main process variable, and then use it as a app-wide singleton to send events across windows.
 */
var NoteService = /** @class */ (function () {
    function NoteService() {
        this.openNoteIds = [];
        this.globalAny = global;
        this.dataStore = this.globalAny.dataStore;
        this.noteRenamed = new rxjs_1.Subject();
        this.noteRenamed$ = this.noteRenamed.asObservable();
        this.noteMarkChanged = new rxjs_1.Subject();
        this.noteMarkChanged$ = this.noteMarkChanged.asObservable();
    }
    NoteService.prototype.openNote = function (noteId) {
        if (!this.openNoteIds.includes(noteId)) {
            this.openNoteIds.push(noteId);
        }
    };
    NoteService.prototype.closeNote = function (noteId) {
        if (this.openNoteIds.includes(noteId)) {
            this.openNoteIds.splice(this.openNoteIds.indexOf(noteId), 1);
        }
    };
    NoteService.prototype.noteIsOpen = function (noteId) {
        return this.openNoteIds.includes(noteId);
    };
    NoteService.prototype.noteExists = function (noteTitle) {
        var activeCollection = this.dataStore.getActiveCollection();
        var note = this.dataStore.getNoteByTitle(activeCollection.id, noteTitle);
        return note != null;
    };
    NoteService.prototype.getSimilarTitles = function (baseTitle) {
        var notesWithIdenticalBaseTitle = this.dataStore.getNotesWithIdenticalBaseTitle(baseTitle);
        return notesWithIdenticalBaseTitle.map(function (x) { return x.title; });
    };
    NoteService.prototype.getUniqueNoteNoteTitle = function (baseTitle) {
        var similarTitles = [];
        var counter = 0;
        var uniqueTitle = baseTitle;
        similarTitles = this.getSimilarTitles(baseTitle);
        while (similarTitles.includes(uniqueTitle)) {
            counter++;
            uniqueTitle = baseTitle + " (" + counter + ")";
        }
        return uniqueTitle;
    };
    NoteService.prototype.renameNote = function (noteId, originalNoteTitle, newNoteTitle) {
        if (!noteId || !originalNoteTitle) {
            electron_log_1.default.error("renameNote: noteId or originalNoteTitle is null");
            return noteOperation_1.NoteOperation.Error;
        }
        var uniqueNoteTitle = newNoteTitle.trim();
        if (uniqueNoteTitle.length === 0) {
            return noteOperation_1.NoteOperation.Blank;
        }
        if (originalNoteTitle === uniqueNoteTitle) {
            electron_log_1.default.error("New title is the same as old title. No rename required.");
            return noteOperation_1.NoteOperation.Success;
        }
        try {
            // 1. Make sure the new title is unique
            uniqueNoteTitle = this.getUniqueNoteNoteTitle(newNoteTitle);
            // 2. Rename the note
            this.dataStore.setNoteTitle(noteId, uniqueNoteTitle);
        }
        catch (error) {
            electron_log_1.default.error("Could not rename the note with id='" + noteId + "' to '" + uniqueNoteTitle + "'. Cause: " + error);
            return noteOperation_1.NoteOperation.Error;
        }
        var args = new noteRenamedArgs_1.NoteRenamedArgs(noteId, uniqueNoteTitle);
        this.noteRenamed.next(args);
        return noteOperation_1.NoteOperation.Success;
    };
    NoteService.prototype.updateNote = function (note) {
        try {
            this.dataStore.updateNote(note);
        }
        catch (error) {
            electron_log_1.default.error("Could not update the note with id='" + note.id + "' to '" + note.title + "'. Cause: " + error);
            return noteOperation_1.NoteOperation.Error;
        }
        return noteOperation_1.NoteOperation.Success;
    };
    NoteService.prototype.setNoteMark = function (noteId, isMarked) {
        this.dataStore.setNoteMark(noteId, isMarked);
        var activeCollection = this.dataStore.getActiveCollection();
        var markedNotes = this.dataStore.getMarkedNotes(activeCollection.id);
        var arg = new noteMarkChangedArgs_1.NoteMarkChangedArgs(noteId, isMarked, markedNotes.length);
        this.noteMarkChanged.next(arg);
    };
    return NoteService;
}());
exports.NoteService = NoteService;
//# sourceMappingURL=note.service.js.map