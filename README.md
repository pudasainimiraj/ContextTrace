# ContextTrace
Context Trace helps you trace the root of decision in your codebase. 

Context Trace is a hybrid search based system that Vectorize each passage of PR desc. comments and discussions using an embedding model, stores the embeddings in a vector database and answers users queries based on the neareast vector match.

Context Trace is for developer tools to accelerate a developers understanding of a repo. I came up with the idea when trying to contribute to open source reposiotries. 

Imagine you are trying to read a code base with 1Millions+ line. You take up an issue and start a discussion but wait for a week to get one single response. 
Not anymore, ContextTrace gives you a full detail of why a certain line was added to the code base. It parses through each split issue, PR description and comments into passages, preservinf each passage's original Github URL and helps you get fimiliar with the code in lightnight speed. 
