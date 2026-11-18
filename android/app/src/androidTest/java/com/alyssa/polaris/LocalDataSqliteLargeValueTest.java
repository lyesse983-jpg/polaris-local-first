package com.alyssa.polaris;

import static org.junit.Assert.*;
import android.database.CursorWindow;
import android.database.sqlite.SQLiteBlobTooBigException;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSArray;
import java.util.Arrays;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android SQLite/CursorWindow regression. Uses only synthetic data. */
@RunWith(AndroidJUnit4.class)
public class LocalDataSqliteLargeValueTest {
    private SQLiteDatabase database;
    private final LocalDataSqlitePlugin plugin = new LocalDataSqlitePlugin();
    private static final String READ = "SELECT value_json FROM local_data_entries WHERE key=? LIMIT 1";

    @Before public void open() {
        database = SQLiteDatabase.create(null);
        database.execSQL("CREATE TABLE local_data_entries (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
    }

    @After public void close() {
        if (database != null && database.isOpen()) database.close();
    }

    @Test public void readsCompleteLargeUnicodeValueWhenCursorWindowCannot() throws Exception {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 450_000; i++) text.append("资料\uD83D\uDE42abc");
        String value = new JSONObject().put("messages", text.toString()).toString();
        database.execSQL("INSERT INTO local_data_entries VALUES (?, ?)", new Object[] {"large-chat", value});
        try (SQLiteCursor cursor = (SQLiteCursor) database.rawQuery(READ, new String[] {"large-chat"})) {
            cursor.setWindow(new CursorWindow("bounded-import-read", 64 * 1024));
            assertThrows(SQLiteBlobTooBigException.class, () -> cursor.moveToFirst());
        }
        JSONArray rows = plugin.runQuery(database, READ, new JSArray(Collections.singletonList("large-chat")));
        assertEquals(1, rows.length());
        assertEquals(value, rows.getJSONObject(0).getString("value_json"));
        assertEquals(value, plugin.runQuery(database, READ, new JSArray(Collections.singletonList("large-chat")))
            .getJSONObject(0).getString("value_json"));
        database.execSQL("INSERT INTO local_data_entries VALUES ('next-domain', '{}')");
        assertEquals("{}", plugin.runQuery(database, READ, new JSArray(Collections.singletonList("next-domain")))
            .getJSONObject(0).getString("value_json"));
    }

    @Test public void returnsMissingOnlyWhenThereIsNoRow() throws Exception {
        assertEquals(0, plugin.runQuery(database, READ, new JSArray(Collections.singletonList("absent"))).length());
    }

    @Test public void preservesSmallValuesAndOtherQueryResults() throws Exception {
        database.execSQL("INSERT INTO local_data_entries VALUES ('small', '{}')");
        assertEquals("{}", plugin.runQuery(database, READ, new JSArray(Collections.singletonList("small")))
            .getJSONObject(0).getString("value_json"));
        assertEquals("small", plugin.runQuery(database,
            "SELECT key FROM local_data_entries WHERE substr(key,1,?)=?", new JSArray(Arrays.asList(2, "sm")))
            .getJSONObject(0).getString("key"));
    }

    @Test public void preservesConversationMetadataText() throws Exception {
        database.execSQL("CREATE TABLE chat_conversation (id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL)");
        database.execSQL("INSERT INTO chat_conversation VALUES ('c', '{\"title\":\"资料🙂\"}')");
        assertEquals("{\"title\":\"资料🙂\"}", plugin.runQuery(database,
            "SELECT metadata_json FROM chat_conversation WHERE id=? LIMIT 1", new JSArray(Collections.singletonList("c")))
            .getJSONObject(0).getString("metadata_json"));
    }

    @Test public void doesNotConvertDatabaseFailureIntoMissingData() throws Exception {
        database.execSQL("DROP TABLE local_data_entries");
        assertThrows(SQLiteException.class, () -> plugin.runQuery(database, READ,
            new JSArray(Collections.singletonList("small"))));
    }
}
