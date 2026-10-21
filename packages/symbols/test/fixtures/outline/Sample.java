// Sample Java file for the outline tests (and the mapping property test).
package com.example.auth;

import java.util.List;
import static java.lang.Math.max;

// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration
/** A session. */
@Entity
public class Session<T extends Comparable<T>> extends Base implements AutoCloseable {
    // How long a session lives.
    private static final int TTL = 3600, MAX_TTL = 7200;
    String token;

    public Session(String token) {
        this.token = token;
    }

    public Session() {
        this("");
    }

    @Override
    public void refresh(boolean force) throws IOException {
        token = rotate(token, force);
    }

    public void refresh() {
        refresh(false);
    }

    public static <K> List<K> of(K... items) {
        return List.of(items);
    }

    static class Inner {
        int depth;

        void walk() {}

        enum Mode { FAST, SLOW }
    }

    { init(); }
}

// A detached note about the file.

interface Store<K> {
    int LIMIT = 10;

    Session get(K id);

    default void put(K id, Session s) {}
}

enum Role {
    ADMIN("a"),
    USER("u");

    private final String code;

    Role(String code) {
        this.code = code;
    }
}

record Point(int x, int y) {
    Point {
        if (x < 0) throw new IllegalArgumentException();
    }

    int sum() { return x + y; }
}

@interface Marker {
    String value() default "";
}
