# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dm.spec.ts >> Direct Messages >> direct messages: send and receive encrypted message
- Location: tests\dm.spec.ts:71:9

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - generic "Direct Messages" [ref=e4]:
      - img [ref=e5]
    - button "+" [ref=e7] [cursor=pointer]
  - generic [ref=e8]:
    - heading "Direct Messages" [level=2] [ref=e10]
    - generic [ref=e11]:
      - button "+ New Message" [ref=e12]
      - generic [ref=e14] [cursor=pointer]:
        - generic [ref=e15]: B
        - generic [ref=e17]: bob_1783851453636
    - generic [ref=e18]:
      - generic [ref=e19]: alice_1783851453636
      - generic [ref=e20]:
        - link "Admin" [ref=e21] [cursor=pointer]:
          - /url: admin.html
        - button "Logout" [ref=e22] [cursor=pointer]
  - generic [ref=e23]:
    - generic [ref=e24]:
      - heading "bob_1783851453636" [level=3] [ref=e25]
      - button "☰" [ref=e26] [cursor=pointer]
    - generic [ref=e27]:
      - generic [ref=e29]: No messages yet. Say hello!
      - generic:
        - generic:
          - button "×"
    - generic [ref=e30]:
      - textbox "Type a message..." [ref=e31]: Hello from DM, user2!
      - button "Send" [active] [ref=e32] [cursor=pointer]
```